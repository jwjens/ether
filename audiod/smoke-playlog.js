// Item 10 Phase 2 Step 4 verification: the daemon writes play_log rows (+ sync mutations) as
// it plays. Self-contained + safe — spawns its OWN daemon against a COPY of openair.db (real
// DB untouched) on a private pipe, drives automation + skip on station 99, then verifies the
// rows landed.  Plays audio → gated.
//   ETHER_SPIKE_FILE="...mp3" node audiod/smoke-playlog.js --i-am-off-air
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");

if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file."); process.exit(2); }
const SID = 99;
const src = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-spike-playlog-" + Date.now() + ".db");
fs.copyFileSync(src, tmp);
for (const ext of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + ext); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-audiod-playlogtest-" + process.pid;

const daemon = cp.spawn(process.execPath, [path.join(__dirname, "ether-audiod.js")], {
  env: { ...process.env, ETHER_DB_PATH: tmp, ETHER_AUDIOD_PIPE: PIPE }, stdio: "ignore",
});

let id = 0, buf = "", sock;
const pending = new Map();
const cmd = (c, args = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.write(JSON.stringify({ id: i, cmd: c, ...args }) + "\n"); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + c)); } }, 5000); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + ext); } catch {} } process.exit(code); }, 300); }

function connect(retries) {
  sock = net.connect(PIPE);
  sock.on("connect", run);
  sock.on("error", () => { if (retries > 0) setTimeout(() => connect(retries - 1), 300); else { console.error("could not connect to test daemon"); cleanup(1); } });
  sock.on("data", d => { buf += d.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } });
}

async function run() {
  try {
    await cmd("ping");
    const items = [0, 1, 2, 3].map(i => ({ filePath: file, title: "PL " + (i + 1), artist: "LogTest", durationMs: 0 }));
    await cmd("enqueue", { stationId: SID, items });
    await cmd("automationStart", { stationId: SID });
    await sleep(2000);
    await cmd("skip", { stationId: SID });
    await sleep(1500);
    await cmd("automationStop", { stationId: SID });
    await sleep(500);

    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("SELECT title, deck, played_at, session_id, uuid FROM play_log WHERE station_id = ? AND title LIKE 'PL %' ORDER BY rowid").all(SID);
    const muts = db.prepare("SELECT COUNT(*) c FROM mutations WHERE table_name = 'play_log' AND op = 'insert'").get().c;
    db.close();
    console.log("play_log rows written by daemon:", rows.length);
    rows.forEach(r => console.log(`  • "${r.title}" deck=${r.deck} played_at=${r.played_at} session=${r.session_id ? "set" : "null"} uuid=${r.uuid ? "set" : "null"}`));
    console.log("play_log insert mutations:", muts);
    const ok = rows.length >= 2 && rows.every(r => r.played_at > 0 && r.uuid) && muts >= rows.length;
    console.log("\n→ STEP 4 VERDICT: " + (ok ? "✅ daemon writes play_log rows + sync mutations to the WAL DB as it plays (Play History survives a UI restart)" : "❌ see above"));
    cleanup(ok ? 0 : 1);
  } catch (e) { console.error("error:", e.message); cleanup(1); }
}
setTimeout(() => connect(20), 900);
