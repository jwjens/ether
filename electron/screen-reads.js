// electron/screen-reads.js — main's side of the screen-read worker (electron/screen-read-worker.js), Jeff 2026-10-26:
// "Screen switching freezes the audio. Nothing on the air path may depend on the screen. Move the screen's database
// reads off the main thread so no screen change can stall audio or timed events."
//
// Main's thread carries the announcement tick, the board, every engine command and the output watchdog. The health
// ledger's main-stall lines on OVEVENTS named the screens' reads as what held it: db:query (183), ha:dashboard (162),
// schedule:get (71). A screen's read now goes to the worker and main only waits on a message — never on SQLite.
//
//   isScreenRead(channel)      — the typed read verbs (…:list, …:get-by-id, …); everything else stays on main.
//   routeScreenReads(ipc, h)   — the ipcMain main hands to sync/handlers installAll: read channels are answered by the
//                                worker (the SAME handler code, captured there), write channels are installed as before.
//   createScreenReadHost(...)  — the worker, its queue, release/reacquire for a database swap, restart if it dies.
// No in-main fallback: a read the worker cannot answer is an error the screen shows, never a stall on main.
"use strict";
const path = require("path");

// The verbs of the typed handlers (electron/sync/handlers) that only read. Every one is run on a read-only connection in
// the worker, so a verb listed here that ever wrote would fail loudly rather than write (scripts/smoke-screen-reads.js
// calls each of them against a database copy).
const READ_VERBS = new Set(["list", "get-by-id", "get-by-int-id", "get", "get-value", "list-by-song", "refs", "counts"]);
function isScreenRead(channel) {
  const s = String(channel || ""), i = s.indexOf(":");
  return i > 0 && READ_VERBS.has(s.slice(i + 1));
}

function routeScreenReads(ipcMain, host) {
  const routed = [];
  return {
    routed,
    handle(channel, fn) {
      if (!isScreenRead(channel)) return ipcMain.handle(channel, fn);
      routed.push(channel);
      return ipcMain.handle(channel, (_e, ...args) =>
        host.channel(channel, args).catch((e) => ({ ok: false, error: String(e && e.message || e) })));
    },
    on: (...a) => ipcMain.on(...a),
    removeHandler: (...a) => ipcMain.removeHandler(...a),
  };
}

function createScreenReadHost({ dbPathFn, log, healthEvent, Worker: WorkerImpl }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  const W = WorkerImpl || require("worker_threads").Worker;
  let worker = null, ready = false, released = false, stopping = false, seq = 0;
  let workerChannels = [];
  const inFlight = new Map();   // id → { msg, resolve, reject }
  const queue = [];             // waiting for the worker to be ready (start, restart, a database swap)
  const recentMs = [];

  function post(entry) {
    inFlight.set(entry.msg.id, entry);
    try { worker.postMessage(entry.msg); }
    catch (e) { inFlight.delete(entry.msg.id); entry.reject(e); }
  }
  function flush() { while (ready && !released && worker && queue.length) post(queue.shift()); }

  function start() {
    if (worker || released || stopping) return;
    ready = false;
    let w;
    try { w = new W(path.join(__dirname, "screen-read-worker.js"), { workerData: { dbPath: dbPathFn() } }); }
    catch (e) {
      say(`[screen-reads] the read worker could not start: ${e && e.message} — screens will show an error until it does`);
      try { if (healthEvent) healthEvent("screen-read-worker-error", { reason: String(e && e.message || e) }); } catch {}
      for (const q of queue.splice(0)) q.reject(e);
      return;
    }
    worker = w;
    w.on("message", (m) => {
      if (!m || typeof m !== "object" || w !== worker) return;
      if (m.type === "ready") { ready = true; workerChannels = m.channels || []; flush(); return; }
      if (m.type === "result") {
        const e = inFlight.get(m.id); if (!e) return;
        inFlight.delete(m.id);
        recentMs.push(m.ms); if (recentMs.length > 50) recentMs.shift();
        m.ok ? e.resolve(m.value) : e.reject(new Error(m.error));
      }
    });
    const gone = (why) => {
      if (w !== worker) return;   // a release ended it on purpose
      worker = null; ready = false;
      const err = new Error(`the screen-read worker stopped (${why})`);
      for (const e of inFlight.values()) e.reject(err);
      inFlight.clear();
      say(`[screen-reads] ${err.message} — restarting it`);
      try { if (healthEvent) healthEvent("screen-read-worker-error", { reason: why }); } catch {}
      if (!stopping && !released) start();
    };
    w.on("error", (e) => gone(String(e && e.message || e)));
    w.on("exit", (code) => gone(`exit ${code}`));
  }

  function request(msg) {
    return new Promise((resolve, reject) => {
      const entry = { msg: { ...msg, id: ++seq }, resolve, reject };
      if (ready && worker && !released) post(entry); else { queue.push(entry); if (!worker && !released) start(); }
    });
  }

  return {
    start,
    /** db:query — rows, as stmt.all. */
    query: (sql, params) => request({ type: "query", sql, params: params || [] }),
    /** A typed read channel, answered by its own handler in the worker. */
    channel: (channel, args) => request({ type: "channel", channel, args: args || [] }),
    /** A read from electron/screen-read-queries.js. */
    fn: (name, ...args) => request({ type: "fn", name, args }),
    /** A database swap: the worker is ended (its connection with it) at once; reads asked meanwhile wait for reacquire(). */
    release: async () => {
      released = true;
      const w = worker; worker = null; ready = false;
      // Reads in flight are put back at the front: they are only reads, and they run again on the reopened database.
      queue.unshift(...[...inFlight.values()].map(e => ({ ...e, msg: { ...e.msg } })));
      inFlight.clear();
      if (w) { try { await w.terminate(); } catch {} }
    },
    /** The database is back (maybe at a new path — sign-in moves the profile folder): a fresh worker opens it. */
    reacquire: () => { released = false; start(); },
    stop: async () => { stopping = true; const w = worker; worker = null; if (w) { try { await w.terminate(); } catch {} } },
    stats: () => ({ running: !!worker && ready, released, queued: queue.length, inFlight: inFlight.size, recentMs: [...recentMs], channels: [...workerChannels] }),
  };
}

module.exports = { READ_VERBS, isScreenRead, routeScreenReads, createScreenReadHost };
