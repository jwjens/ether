// electron/show-log-worker.js — the "which show hours have no log yet" check (electron/show-log-spans.js) on its own
// thread with its own READ-ONLY connection, so the main thread never waits on the database for it (Jeff, 2026-10-20,
// after 4.6.60 froze main ~58 s every minute on ovowforestmusic). Main posts { id, nowTs, dbPath } (the live
// database's path each time, so a profile change is followed); the worker
// answers { id, ok, stations, ms } or { id, ok:false, error }. It never writes: building the log stays on main
// (_generateRange), only for the spans returned here.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3");
const { stationsToBuild } = require("./show-log-spans");

let db = null, dbPath = null;
function open(want) {
  if (db && dbPath === want) return db;
  try { if (db) db.close(); } catch {}
  db = new Database(want, { readonly: true, fileMustExist: true });
  dbPath = want;
  db.pragma("busy_timeout = 5000");
  return db;
}

parentPort.on("message", (m) => {
  // A database swap closes this connection before it replaces the file (electron/db-holders.js); main then ends the worker.
  if (m && m.type === "close") {
    try { if (db) db.close(); } catch {}
    db = null; dbPath = null;
    parentPort.postMessage({ type: "closed" });
    return;
  }
  if (!m || m.type !== "check") return;
  const t0 = Date.now();
  try {
    const d = open(m.dbPath || workerData.dbPath);
    // No builder designation (Jeff, 2026-10-20): every computer builds its OWN log for every station.
    const gate = () => ({ allow: true });
    const stations = stationsToBuild(d, m.nowTs, gate);
    parentPort.postMessage({ type: "result", id: m.id, ok: true, stations, ms: Date.now() - t0 });
  } catch (e) {
    // A connection that failed (a restore swapped the file, say) is reopened on the next check.
    try { if (db) db.close(); } catch {}
    db = null;
    parentPort.postMessage({ type: "result", id: m.id, ok: false, error: e.message, ms: Date.now() - t0 });
  }
});
parentPort.on("close", () => { try { if (db) db.close(); } catch {} });
