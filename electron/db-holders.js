// electron/db-holders.js — EVERY CONNECTION ETHER HOLDS TO THE STATION DATABASE, so a swap can close all of them.
//
// Jeff, 2026-10-21 (4.6.62, work PC, joining HalloVeen by sync): "openair.db-wal and openair.db-shm could not be released
// ... something outside Ether is holding those files". It was Ether itself. swapDatabaseFile closed main's connection and
// asked the audio daemon to close its own — but the worker threads kept theirs: the show-log worker (4.6.61) and the
// library-health worker hold a read-only connection for the life of the app, and the backup / startup / sync-cleanup
// workers can be mid-run. On Windows any one of them keeps -wal/-shm locked. docs/db-release-on-swap-2026-10-21.md.
//
// Two kinds, both closed by releaseAll():
//   • PERSISTENT holders (register): a worker that keeps a connection open. release() closes it and must not reopen it
//     until reacquire(); both are given by the holder's owner.
//   • TRANSIENT workers (track): a worker that opens, works, exits. releaseAll() waits for it to finish, then stops it.
//     While released, a newly tracked worker is stopped at once (its owner's exit handler reports it as not run).
// Main's own connection and the daemon's are released by swapDatabaseFile itself; they are not in here.
"use strict";

const RELEASE_WAIT_MS = 5000;

function _within(p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer within ${ms} ms`)), ms); }),
  ]);
}

/**
 * Close a worker's own connection, then end the worker: post { type: "close" }, wait for { type: "closed" } (at most
 * `waitMs`), terminate. Used for a worker whose owner starts a fresh one after the swap (the show-log worker).
 */
async function closeWorkerConnection(w, { waitMs = 2000 } = {}) {
  if (!w) return;
  await new Promise((res) => {
    const t = setTimeout(done, waitMs);
    function done() { clearTimeout(t); w.off("message", onMsg); res(); }
    function onMsg(m) { if (m && m.type === "closed") done(); }
    w.on("message", onMsg);
    try { w.postMessage({ type: "close" }); } catch { done(); }
  });
  await w.terminate();
}

function createDbHolders({ log } = {}) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  const holders = new Map();     // name → { release, reacquire }
  const transient = new Map();   // Worker → name
  let released = false;

  /** A worker that keeps its own connection open. `release()` closes it (may return a promise); `reacquire()` lets it reopen. */
  function register(name, { release, reacquire }) { holders.set(name, { release, reacquire }); }
  function unregister(name) { holders.delete(name); }

  /** A worker that opens the database for one job. Returns the worker. While released it is stopped at once. */
  function track(name, worker) {
    if (!worker) return worker;
    if (released) {
      say(`[db-holders] ${name} not run — the station database is being replaced`);
      try { worker.terminate(); } catch {}
      return worker;
    }
    transient.set(worker, name);
    worker.once("exit", () => transient.delete(worker));
    return worker;
  }

  function isReleased() { return released; }

  /** The names that hold (or may hold) a connection right now. */
  function names() { return [...holders.keys(), ...transient.values()]; }

  /**
   * Close every connection in here. → [{ name, ok, how?, error? }] — one line per holder, so a failure names which part of
   * Ether did not let go. Never throws.
   */
  async function releaseAll({ waitMs = RELEASE_WAIT_MS } = {}) {
    released = true;
    const out = [];
    for (const [name, h] of holders) {
      try { await _within(h.release(), waitMs, name); out.push({ name, ok: true, how: "closed" }); }
      catch (e) { out.push({ name, ok: false, error: String(e && e.message || e) }); }
    }
    for (const [w, name] of [...transient]) {
      const exited = new Promise((res) => { if (!transient.has(w)) res(); else w.once("exit", res); });
      try { await _within(exited, waitMs, name); out.push({ name, ok: true, how: "finished" }); continue; } catch {}
      try { await _within(w.terminate(), waitMs, name); out.push({ name, ok: true, how: "stopped" }); }
      catch (e) { out.push({ name, ok: false, error: String(e && e.message || e) }); }
    }
    for (const r of out) say(`[db-holders] ${r.name}: ${r.ok ? r.how : "DID NOT RELEASE — " + r.error}`);
    return out;
  }

  /** Let every persistent holder reopen. Always safe to call, released or not. */
  function reacquireAll() {
    released = false;
    for (const [name, h] of holders) {
      try { h.reacquire(); } catch (e) { say(`[db-holders] ${name}: reopen failed — ${e && e.message}`); }
    }
  }

  return { register, unregister, track, isReleased, names, releaseAll, reacquireAll };
}

/**
 * The operator's sentence when -wal/-shm stay locked. Says WHO holds them, from what was observed: an Ether part that did
 * not release (heldBy), or the processes Windows reports (holders, electron/file-lockers-win.js). Outside software is
 * named only when Windows names it — never assumed (the 4.6.62 message blamed "something outside Ether" when it was Ether).
 */
function stuckFilesMessage(stuck, heldBy, holders, isEther = require("./file-lockers-win").isEther) {
  const files = stuck.join(" and ");
  const tail = " Your current station is untouched and still running.";
  const failed = (heldBy || []).filter(r => !r.ok).map(r => r.name);
  const ours = (holders || []).filter(h => isEther(h));
  const others = (holders || []).filter(h => !isEther(h));
  const who = (hs) => hs.map(h => `${h.app || h.process || "a program"} (${h.process ? h.process + ".exe, " : ""}process ${h.pid})`).join(", ");
  if (failed.length || (ours.length && !others.length)) {
    const part = failed.length ? ` (${failed.join(", ")} did not close its connection)` : "";
    return `Sync couldn't start: Ether itself is still holding ${files}${part}. Close Ether completely, including from the tray, open it again and run the sync again.${tail}`;
  }
  if (others.length) {
    return `Sync couldn't start: ${files} are in use by ${who(others)}${ours.length ? ", and by Ether" : ""}. Close ${others.length === 1 ? "that program" : "those programs"} (or let it finish) and run the sync again.${tail}`;
  }
  return `Sync couldn't start: ${files} are still locked after Ether closed every connection it holds, and Windows did not say which program has them. Close Ether completely, including from the tray, open it again and run the sync again.${tail}`;
}

// One registry for the app: main's swap and the modules that start workers (backups.js, cloud-backup.js) share it.
const dbHolders = createDbHolders({ log: (m) => console.log(m) });

module.exports = { createDbHolders, dbHolders, closeWorkerConnection, stuckFilesMessage, RELEASE_WAIT_MS };
