// Item 10 Phase 2 Step 4 spike. Proves the daemon (node:sqlite, read-WRITE) and the app
// (better-sqlite3) can both write the SAME WAL SQLite DB from separate processes with no
// corruption and no hard lock failures — the precondition for moving play-logging into the
// daemon (it writes play_log + last_played_at while the app still has openair.db open).
//
// SAFE: runs against a COPY of openair.db in the temp dir (the real DB is never touched) and
// only writes a scratch table. Real plays happen every few minutes; this bursts thousands of
// concurrent inserts from two processes/bindings to stress the lock path far beyond reality.
//
//   node scripts/spike-write-contention.js
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const src = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-spike-contention-" + Date.now() + ".db");
fs.copyFileSync(src, tmp);
for (const ext of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + ext); } catch {} }
// Use the packaged Ether.exe if present (most faithful), else the dev electron.
const ETHER = path.join(__dirname, "..", "dist-electron", "win-unpacked", "Ether.exe");
const EXE = process.env.ETHER_ELECTRON || (fs.existsSync(ETHER) ? ETHER : path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe"));
const N = 2000;

const db = new DatabaseSync(tmp);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS _spike_log(id INTEGER PRIMARY KEY, src TEXT, n INTEGER, ts INTEGER)");
const insB = db.prepare("INSERT INTO _spike_log(src, n, ts) VALUES (?, ?, ?)");

// Spawn writer A (better-sqlite3 under Electron) — runs concurrently with writer B below.
const child = cp.spawn(EXE, [path.join(__dirname, "spike-write-bsq.js"), tmp, "app-bsq", String(N)],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let aOut = "", aErr = "", aClosed = false;
child.stdout.on("data", d => aOut += d); child.stderr.on("data", d => aErr += d);

// Writer B (node:sqlite, daemon role) — batched on setImmediate so it yields the event loop
// and genuinely overlaps writer A's process lifetime (real cross-process lock contention).
let bIns = 0, bBusy = 0, bOther = 0, bLastErr = "", bDone = false;
const t0 = Date.now();
let bMs = 0;
function bStep() {
  for (let k = 0; k < 25 && (bIns + bBusy + bOther) < N; k++) {
    try { insB.run("daemon-nodesqlite", bIns, Date.now()); bIns++; }
    catch (e) { if (/busy|locked/i.test(e.message)) bBusy++; else { bOther++; bLastErr = e.message; } }
  }
  if ((bIns + bBusy + bOther) < N) setImmediate(bStep);
  else { bMs = Date.now() - t0; bDone = true; maybeFinish(); }
}
setImmediate(bStep);

child.on("close", () => { aClosed = true; maybeFinish(); });

let finished = false;
function maybeFinish() {
  if (finished || !bDone || !aClosed) return;
  finished = true;
  let a = {}; try { a = JSON.parse(aOut.trim().split("\n").pop()); } catch {}
  const total = db.prepare("SELECT COUNT(*) c FROM _spike_log").get().c;
  const bySrc = db.prepare("SELECT src, COUNT(*) c FROM _spike_log GROUP BY src ORDER BY src").all();
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const aVisible = db.prepare("SELECT COUNT(*) c FROM _spike_log WHERE src = 'app-bsq'").get().c; // node:sqlite reads better-sqlite3's rows
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + ext); } catch {} }

  console.log("runtime for writer A:", path.basename(EXE));
  console.log("writer B (daemon / node:sqlite) :", JSON.stringify({ inserted: bIns, busy: bBusy, other: bOther, ms: bMs, lastErr: bLastErr }));
  console.log("writer A (app / better-sqlite3) :", JSON.stringify(a), aErr.trim() ? "\n  stderr: " + aErr.trim().slice(0, 300) : "");
  console.log("rows total:", total, "| by src:", JSON.stringify(bySrc));
  console.log("integrity_check:", integrity, "| writer-A rows visible to node:sqlite:", aVisible);

  const ok = bOther === 0 && (a.other === 0) && integrity === "ok"
    && total === bIns + (a.inserted || 0) && aVisible === (a.inserted || 0) && aVisible > 0 && bIns > 0;
  console.log("\n→ STEP 4 VERDICT: " + (ok
    ? "✅ cross-process WAL writes are safe — no corruption, no hard failures, fully cross-visible. Daemon can own play-logging."
    : "❌ see above (hard errors, integrity, count mismatch, or no overlap)"));
  process.exit(ok ? 0 : 1);
}
