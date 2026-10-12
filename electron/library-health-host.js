// electron/library-health-host.js — main's side of the library-health worker (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. The same API main has always used (snapshot, eligibilityRows,
// lintRows, goalCheck, noteSkip, noteGenerate, start), backed by electron/library-health-worker.js so nothing in it can
// block the main process. Queries come back as promises (ipcMain.handle awaits them). If the worker cannot start, main
// falls back to running library-health itself, exactly as before, and says so loudly — the senses never go dark.
"use strict";
const path = require("path");

function createLibraryHealthHost({ dbPathFn, ctxFn, userDataDir, backendUrl, broadcast, log, healthEvent, inMainFallback }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  let worker = null, fallback = null, lastSnapshot = { stations: [], t: null };
  let seq = 0;
  const waiting = new Map();
  const callTimes = [];   // the last answers, for the stats line

  function useFallback(why) {
    if (fallback) return fallback;
    say(`[library-health] worker unavailable (${why}) — running the sweep ON MAIN as before; the UI can stall during each sweep`);
    try { if (healthEvent) healthEvent("library-health-worker-error", { reason: why, message: `The library-health sweep is running on the main thread (${why}) — expect brief UI stalls every 2 minutes` }); } catch {}
    fallback = inMainFallback();
    fallback.start();
    return fallback;
  }

  function sendCtx() { try { if (worker) worker.postMessage({ type: "ctx", ctx: { dbPath: dbPathFn(), ...ctxFn() } }); } catch {} }

  function start() {
    try {
      const { Worker, SHARE_ENV } = require("worker_threads");
      worker = new Worker(path.join(__dirname, "library-health-worker.js"), {
        env: SHARE_ENV,
        workerData: { dbPath: dbPathFn(), userDataDir, backendUrl, ...ctxFn() },
      });
    } catch (e) { worker = null; useFallback(String(e && e.message || e)); return; }
    worker.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "ready") { sendCtx(); worker.postMessage({ type: "start" }); say("[library-health] sweep running in its own thread (main is never blocked by it)"); return; }
      if (m.type === "broadcast") {
        if (m.channel === "library-health") lastSnapshot = m.data;
        try { broadcast(m.channel, m.data); } catch {}
        return;
      }
      if (m.type === "result") {
        const w = waiting.get(m.id); if (!w) return;
        waiting.delete(m.id);
        callTimes.push(m.ms); if (callTimes.length > 50) callTimes.shift();
        m.ok ? w.resolve(m.value) : w.reject(new Error(m.error));
        return;
      }
      if (m.type === "log") { say(m.msg); return; }
      if (m.type === "fatal") { say(`[library-health] worker fatal: ${m.error}`); try { worker.terminate(); } catch {} worker = null; useFallback(m.error); }
    });
    worker.on("error", (e) => { say(`[library-health] worker error: ${e && e.message}`); worker = null; for (const w of waiting.values()) w.reject(e); waiting.clear(); useFallback(String(e && e.message || e)); });
    worker.on("exit", (code) => { if (worker && code !== 0) { worker = null; useFallback(`worker exited ${code}`); } });
    // The things only main knows (library folder, restore in flight, license) — refreshed every 10 s, never blocking.
    const t = setInterval(sendCtx, 10000); if (t.unref) t.unref();
  }

  function call(method, args, fallbackFn) {
    if (fallback) return Promise.resolve().then(fallbackFn);
    if (!worker) return Promise.resolve().then(() => useFallback("not started")).then(fallbackFn);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try { worker.postMessage({ type: "call", id, method, args }); } catch (e) { waiting.delete(id); reject(e); }
    });
  }
  function note(method, args) {
    if (fallback) { try { fallback[method](...args); } catch {} return; }
    try { if (worker) worker.postMessage({ type: "note", method, args }); } catch {}
  }

  return {
    start,
    snapshot: () => (fallback ? fallback.snapshot() : lastSnapshot),
    eligibilityRows: (sid) => call("eligibilityRows", [sid], () => fallback.eligibilityRows(sid)),
    lintRows: (sid) => call("lintRows", [sid], () => fallback.lintRows(sid)),
    goalCheck: (_db, sid) => call("goalCheck", [sid], () => fallback.goalCheck(_db, sid)),
    /** A heavy SELECT on the worker's read-only connection (main is never blocked by it). */
    query: (sql, params) => call("query", [sql, params], () => { throw new Error("the worker is not running — use db:query"); }),
    noteSkip: (...a) => note("noteSkip", a),
    noteGenerate: (...a) => note("noteGenerate", a),
    /** For tests and the health line: is the worker carrying it, and how long its answers took. */
    stats: () => ({ inWorker: !!worker && !fallback, recentCallMs: [...callTimes] }),
  };
}

module.exports = { createLibraryHealthHost };
