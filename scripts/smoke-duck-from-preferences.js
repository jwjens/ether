// scripts/smoke-duck-from-preferences.js — the ducker's values come only from Preferences, on the REAL daemon (2026-10-13).
//
// docs/duck-from-preferences-2026-10-13.md. Jeff: "The engine must have no duck amount of its own … If Preferences and the
// engine ever disagree, it shows on the Health page as an error."
// The real daemon (audiod/ether-audiod.js + the built native/ether-audio.node) on a private pipe and a throwaway database:
//   1. a station whose Preferences have NO ducker values: the engine holds none (board snapshot duck_params null), and the
//      board check names it ("Ducker settings in Preferences");
//   2. main's step writes the STARTING values into Preferences (board-state seedDuckPreferences, audiod/duck-defaults.js),
//      the applier sends them: the engine holds exactly them, the board check is silent;
//   3. the engine is told something Preferences did not say: the board check names it ("Ducker depth").
// Never touches the installed app, its pipe or its database.
//   node scripts/smoke-duck-from-preferences.js
"use strict";
const net = require("net"), path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const B = require("../audiod/board-state");
const START = require("../audiod/duck-defaults");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-duck-prefs-"));
const DB = path.join(TMP, "openair.db");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT);
           CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
           INSERT INTO stations (id, name) VALUES (1, 'Park');
           INSERT INTO deck_configs VALUES (1, 'A', 'music', '', 1, 1, 0, 1, NULL), (1, 'D', 'source', 'announcement', 1, 1, 1, 0, NULL);
           INSERT INTO station_config_kv VALUES (1, 'monitor_volume', '0.5', NULL), (1, 'master_monitor_volume', '0.5', NULL);`);
  db.close();
}
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\ether-duck-prefs-${process.pid}` : path.join(TMP, "d.sock");
const ask = (cmd, args = {}) => new Promise((res) => {
  const s = net.connect(PIPE); let buf = "", done = false;
  const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };
  s.once("connect", () => s.write(JSON.stringify({ id: 1, cmd, ...args }) + "\n"));
  s.on("data", (d) => { buf += d; const nl = buf.indexOf("\n"); if (nl < 0) return; try { const m = JSON.parse(buf.slice(0, nl)); fin(m.ok ? m.result : { ok: false, reason: m.error }); } catch { fin(null); } });
  s.once("error", () => fin(null)); setTimeout(() => fin(null), 4000);
});
const duckOnly = (d) => d.filter(x => /^duck(Depth|Threshold|Attack|Hold|Release|Prefs|Engine)$/.test(x.setting));

(async () => {
  const child = cp.spawn(process.execPath, [path.join(ROOT, "audiod", "ether-audiod.js")], { stdio: "ignore",
    env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE, ETHER_DB_PATH: DB, ETHER_AUDIOD_LOG: path.join(TMP, "audiod.log") } });
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { const p = await ask("ping"); up = !!(p && p.pong); if (!up) await sleep(250); }
    ok(up, "the real daemon is up");
    const live = async () => { for (let i = 0; i < 40; i++) { const b = await ask("getBoardState", { stationId: 1 }); if (b && b.ok && b.applied) return b; await sleep(250); } return null; };
    const ro = () => new DatabaseSync(DB, { readOnly: true });

    // 1 · no ducker values in Preferences
    await ask("applySavedBoard", { reason: "smoke: nothing in Preferences" });
    let b = await live(), db = ro();
    let saved = B.readSavedBoard(db, 1); db.close();
    ok(b && b.control && b.control.duck_params === null, `1 · Preferences have no ducker values → the engine holds none (duck_params ${JSON.stringify(b && b.control && b.control.duck_params)})`);
    const d1 = duckOnly(B.compareBoard(saved, b));
    ok(d1.length === 1 && d1[0].setting === "duckPrefs" && d1[0].label === "Ducker settings in Preferences", `1 · the board check names it: ${d1.map(x => `${x.label} — ${x.saved}`).join("; ")}`);

    // 2 · the starting values are written INTO Preferences, then applied
    const w = new DatabaseSync(DB);
    const wrote = B.seedDuckPreferences(w, 1, (sid, key, value) => w.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)").run(sid, key, value));
    w.close();
    ok(wrote.length === 5, `2 · the five starting values were written into Preferences (${wrote.join(", ")})`);
    await ask("applySavedBoard", { reason: "smoke: after the starting values" });
    b = await live(); db = ro(); saved = B.readSavedBoard(db, 1); db.close();
    const ld = b && b.control && b.control.duck_params;
    ok(ld && Math.abs(ld.depth_db - START.depthDb) < 1e-6 && Math.abs(20 * Math.log10(ld.threshold) - START.thresholdDb) < 0.01
       && ld.attack_ms === START.attackMs && ld.hold_ms === START.holdMs && ld.release_ms === START.releaseMs,
       `2 · the engine holds exactly Preferences' values (${JSON.stringify(ld)})`);
    ok(duckOnly(B.compareBoard(saved, b)).length === 0, "2 · the board check is silent — Preferences and the engine agree");

    // 3 · the engine is told something Preferences did not say
    await ask("setDuckParams", { stationId: 1, depthDb: -30, thresholdDb: START.thresholdDb, attackMs: START.attackMs, holdMs: START.holdMs, releaseMs: START.releaseMs });
    await sleep(300);
    b = await live();
    const d3 = duckOnly(B.compareBoard(saved, b));
    ok(d3.length === 1 && d3[0].setting === "duckDepth" && d3[0].saved === START.depthDb && Math.abs(d3[0].live + 30) < 1e-6,
       `3 · a disagreement is named: ${d3.map(x => `${x.label} — Preferences ${x.saved}, engine ${x.live}`).join("; ")}`);
  } finally { try { child.kill(); } catch {} await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})();
