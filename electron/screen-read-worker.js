// electron/screen-read-worker.js — every screen's database reads, on their own thread with their own READ-ONLY connection
// (Jeff, 2026-10-26: "Screen switching freezes the audio. Nothing on the air path may depend on the screen."). Main's
// thread carries the announcement tick, the board and every engine command; a screen opening used to run its reads on
// that same thread (db:query, the typed :list/:get channels, schedule:get) and everything on air waited behind them.
//
// Main posts:
//   { type:"query",   id, sql, params }   → the renderer's db:query (rows, as stmt.all)
//   { type:"channel", id, channel, args } → a typed read channel, answered by the SAME handler code main installs
//                                           (sync/handlers installAll, captured here against this connection)
//   { type:"fn",      id, name, args }    → a read written for main.js, from electron/screen-read-queries.js
//   { type:"release", id }                → close the connection (a database swap); answered { type:"released", id }
//   { type:"reacquire", dbPath }          → the database to open on the next read (it may have moved — sign-in)
// and gets { type:"result", id, ok, value | error, ms }. The connection is read-only, so nothing here can write.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3");
const queries = require("./screen-read-queries");

let db = null, dbPath = workerData && workerData.dbPath, released = false;
function open() {
  if (released) throw new Error("the station database is being reopened");
  if (db) return db;
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}
function close() { try { if (db) db.close(); } catch {} db = null; }

// The typed handlers, exactly as main installs them, bound to this connection.
const channels = new Map();
const captureIpc = { handle: (ch, fn) => { channels.set(ch, fn); }, on: () => {}, removeHandler: (ch) => { channels.delete(ch); } };
require("./sync/handlers/index").installAll(captureIpc, () => open());

function answer(id, t0, fn) {
  try {
    const value = fn();
    parentPort.postMessage({ type: "result", id, ok: true, value, ms: Date.now() - t0 });
  } catch (e) {
    // A connection that failed (the file was swapped under it) is reopened on the next read.
    if (!released) close();
    parentPort.postMessage({ type: "result", id, ok: false, error: String(e && e.message || e), ms: Date.now() - t0 });
  }
}

parentPort.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  const t0 = Date.now();
  if (m.type === "release") { released = true; close(); parentPort.postMessage({ type: "released", id: m.id }); return; }
  if (m.type === "reacquire") { if (m.dbPath) dbPath = m.dbPath; released = false; close(); return; }
  if (m.type === "query") return answer(m.id, t0, () => open().prepare(m.sql).all(...(m.params || [])));
  if (m.type === "fn") return answer(m.id, t0, () => {
    const f = queries[m.name];
    if (typeof f !== "function") throw new Error(`no screen read named ${m.name}`);
    return f(open(), ...(m.args || []));
  });
  if (m.type === "channel") return answer(m.id, t0, () => {
    const h = channels.get(m.channel);
    if (!h) throw new Error(`no read handler for ${m.channel}`);
    const r = h(null, ...(m.args || []));
    if (r && typeof r.then === "function") throw new Error(`${m.channel} is asynchronous — not a plain read`);
    return r;
  });
});
parentPort.on("close", close);
parentPort.postMessage({ type: "ready", channels: [...channels.keys()] });
