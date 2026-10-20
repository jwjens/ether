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
const desig = require("./generation-designation");

let db = null, dbPath = null;
function open(want) {
  if (db && dbPath === want) return db;
  try { if (db) db.close(); } catch {}
  db = new Database(want, { readonly: true, fileMustExist: true });
  dbPath = want;
  db.pragma("busy_timeout = 5000");
  return db;
}
const kv = (d, sid, key) => {
  const r = d.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL LIMIT 1").get(sid, key);
  return r ? r.value : null;
};

parentPort.on("message", (m) => {
  if (!m || m.type !== "check") return;
  const t0 = Date.now();
  try {
    const d = open(m.dbPath || workerData.dbPath);
    // The same gate main used (generation-designation.js mayAutoGenerate), asked FIRST for every station.
    // This machine's identity, read here (main sends none): the same client_identity main's _machineIdentity() reads.
    const me = d.prepare("SELECT client_id FROM client_identity LIMIT 1").get();
    const machineId = me && me.client_id ? me.client_id : null;
    const gate = (sid) => desig.mayAutoGenerate({
      record: desig.parseRecord(kv(d, sid, desig.KEY)), machineId,
      killSwitch: String(kv(d, sid, "kill_designation") || "") === "1",
    });
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
