// scripts/smoke-db-release.js — a database swap must be able to remove -wal/-shm while Ether's own worker connections are
// running, because releaseAll() closes them first (electron/db-holders.js). REAL FILES, REAL WORKERS: the show-log worker
// and the library-health worker (through its host), each holding its read-only connection exactly as in the app.
// Jeff, 2026-10-21 (4.6.62): "openair.db-wal and openair.db-shm could not be released … It's Ether itself."
// Run: npm run test:db-release   (Electron as Node — better-sqlite3 is built for Electron)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const Database = require("better-sqlite3");
const { createDbHolders, closeWorkerConnection } = require("../electron/db-holders");
const { createLibraryHealthHost } = require("../electron/library-health-host");

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-db-release-"));
const dbPath = path.join(dir, "openair.db");
const sidecars = () => ["-wal", "-shm"].filter(s => fs.existsSync(dbPath + s)).map(s => path.basename(dbPath + s));
const tryDrop = () => { for (const s of ["-wal", "-shm"]) { try { fs.rmSync(dbPath + s, { force: true }); } catch {} } return sidecars(); };

function showLogWorker() {
  const w = new Worker(path.join(__dirname, "..", "electron", "show-log-worker.js"), { workerData: { dbPath } });
  const check = (id) => new Promise((res) => { const on = (m) => { if (m && m.id === id) { w.off("message", on); res(m); } }; w.on("message", on); w.postMessage({ type: "check", id, nowTs: Math.floor(Date.now() / 1000), dbPath }); });
  return { w, check };
}

(async () => {
  // The station database, in WAL mode, the way main opens it — with a write so the -wal holds frames.
  const main = new Database(dbPath);
  main.pragma("journal_mode = WAL");
  main.exec("CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT); CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, is_active INTEGER, deleted_at TEXT);");
  main.prepare("INSERT INTO stations (name) VALUES (?)").run("HalloVeen");
  main.prepare("UPDATE stations SET deleted_at = 'x'").run();   // no live station: the show-log check has nothing to build

  // 1. The two persistent holders, connected.
  const sl = showLogWorker();
  const r1 = await sl.check(1);
  check(r1.ok === true, `show-log worker answered a check on its own connection (${r1.ok ? "ok" : r1.error})`);
  const lh = createLibraryHealthHost({
    dbPathFn: () => dbPath, ctxFn: () => ({}), userDataDir: dir, backendUrl: null,
    broadcast: () => {}, log: () => {}, healthEvent: () => {},
    inMainFallback: () => { throw new Error("library-health fell back to main — the worker did not start"); },
  });
  lh.start();
  const q1 = await lh.query("SELECT COUNT(*) AS n FROM stations", []);
  check(Array.isArray(q1) && q1[0].n === 1, "library-health worker answered a query on its own connection");

  // 2. The 4.6.62 failure, reproduced: main closes ITS connection (as swapDatabaseFile does) and the journals stay locked.
  main.pragma("wal_checkpoint(TRUNCATE)");
  main.close();
  const before = tryDrop();
  if (process.platform === "win32") {
    check(before.length > 0, `before release: Windows refuses to remove ${before.join(", ") || "(nothing)"} — the workers hold them (the reported bug)`);
    // The message is built from what Windows reports: here the holder is this process — Ether — not outside software.
    const { whoHolds, isEther } = require("../electron/file-lockers-win");
    const { stuckFilesMessage } = require("../electron/db-holders");
    const held = await whoHolds(before.map(n => path.join(dir, n)));
    check(held.some(h => h.pid === process.pid && isEther(h)), `Windows names the holder: ${held.map(h => `${h.process} (pid ${h.pid})`).join(", ") || "none reported"} — this process is ${process.pid}`);
    const msg = stuckFilesMessage(before, [], held);
    check(/Ether itself is still holding/.test(msg) && !/outside Ether|antivirus/i.test(msg), `message: "${msg}"`);
  } else console.log(`SKIP  lock reproduction (Windows only; here: ${before.join(", ") || "removed"})`);

  // 3. The fix: release every holder (the same release code main registers), then the journals go.
  const holders = createDbHolders();
  let slw = sl.w;
  holders.register("show-log worker", { release: () => { const w = slw; slw = null; return closeWorkerConnection(w); }, reacquire: () => {} });
  holders.register("library-health worker", { release: () => lh.release(), reacquire: () => lh.reacquire() });
  const out = await holders.releaseAll();
  check(out.every(r => r.ok), `released: ${out.map(r => `${r.name} ${r.ok ? r.how : "FAILED " + r.error}`).join("; ")}`);
  const after = tryDrop();
  check(after.length === 0, `after release: -wal and -shm removed (${after.length ? "still there: " + after.join(", ") : "gone"})`);

  // 4. While released, the library-health worker does not reopen the file behind the swap.
  let refused = null;
  try { await lh.query("SELECT 1", []); } catch (e) { refused = e.message; }
  check(/RESTORE_IN_PROGRESS/.test(String(refused)), "while released, the library-health worker refuses to reopen");
  check(tryDrop().length === 0, "while released, nothing recreated -wal/-shm");

  // 5. A new file in place, then reacquire: both read the NEW database.
  const fresh = new Database(dbPath);
  fresh.pragma("journal_mode = WAL");
  fresh.prepare("INSERT INTO stations (name) VALUES (?)").run("after the swap");
  holders.reacquireAll();
  const q2 = await lh.query("SELECT COUNT(*) AS n FROM stations", []);
  check(q2[0].n === 2, "after reacquire: library-health reads the database again");
  const sl2 = showLogWorker();
  const r2 = await sl2.check(2);
  check(r2.ok === true, "after reacquire: a new show-log worker answers again");

  await sl2.w.terminate();
  try { await lh.release(); } catch {}
  fresh.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAIL  smoke crashed:", e && e.stack || e); process.exit(1); });
