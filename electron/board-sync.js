// electron/board-sync.js — main's half of "a fader is never asleep" (2026-10-11).
//
// docs/board-state-on-connect-diagnosis-2026-10-11.md. Three things the windows used to do alone, badly:
//
//  1. SEND. A board setter from a window goes to the engine that is running. While the app is on its in-process
//     fallback, it ALSO waits in a queue for the daemon — the 2026-10-11 failure was exactly those values reaching the
//     in-process engine and never the daemon. A send that fails (daemon not connected, a timeout) is queued and logged,
//     never swallowed. Only the latest value per (command, station, fader) is kept: it is the board's state that
//     matters, not the history of a drag.
//  2. ON CONNECT. The daemon re-applies every station's saved board (audiod/board-state.js — the same module it runs at
//     its own start), then the queue is flushed (newer than the saved values, so it goes second).
//  3. READ BACK. After a settle, every station's live values are read (getBoardState) and compared with the saved
//     board; any difference is a red board-state-mismatch-error naming the setting, the saved and the live value.
"use strict";

const keyOf = (cmd, args) => `${cmd}|${args && args.stationId}|${(args && (args.deck ?? args.slot)) ?? ""}`;

function createBoardQueue({ log } = {}) {
  const q = new Map();          // key → { cmd, args, reason }
  const said = new Set();       // keys already logged since the last flush (a drag is one line, not fifty)
  const say = (m) => { try { if (log) log(m); } catch {} };
  return {
    enqueue(cmd, args, reason) {
      const k = keyOf(cmd, args);
      q.set(k, { cmd, args, reason });
      if (!said.has(k)) { said.add(k); say(`[board] ${cmd} ${args && (args.deck ?? args.slot ?? "")} s${args && args.stationId} queued for the audio engine (${reason}) — applied on connect`); }
    },
    size() { return q.size; },
    entries() { return [...q.values()]; },
    /** Send everything queued, in order of first queuing. A send that fails again stays queued, and says so. */
    async flush(send) {
      const items = [...q.entries()];
      let sent = 0, failed = 0;
      for (const [k, it] of items) {
        try { await send(it.cmd, it.args); q.delete(k); sent++; }
        catch (e) { failed++; say(`[board] ${it.cmd} s${it.args && it.args.stationId} still NOT delivered ✗ ${e && e.message || e}`); }
      }
      said.clear();
      if (items.length) say(`[board] queued board changes delivered: ${sent}${failed ? `, ${failed} still queued` : ""}`);
      return { sent, failed };
    },
  };
}

/**
 * Route one board setter. Returns what the engine returned (or false), and never throws.
 *   daemonActive   — main is routing audio to the daemon right now
 *   daemonWanted   — a daemon is the intended engine (so the in-process fallback is temporary)
 *   toDaemon(cmd, args) — audiodClient.cmd
 *   inProcess()    — the same setter on the in-process addon
 */
async function boardSend({ cmd, args, daemonActive, daemonWanted, toDaemon, inProcess, queue }) {
  if (daemonActive) {
    try { return await toDaemon(cmd, args); }
    catch (e) { queue.enqueue(cmd, args, String(e && e.message || e)); return false; }
  }
  let r = false;
  try { r = inProcess ? inProcess() : false; } catch (e) { r = false; }
  if (daemonWanted) queue.enqueue(cmd, args, "the app is on its in-process fallback");
  return r;
}

/**
 * The connect pass. Never throws; returns the per-station verdicts.
 *   cmd(name, args)        — audiodClient.cmd
 *   stations()             — station ids to check
 *   readSaved(sid)         — board-state.readSavedBoard(db, sid)
 *   compare(saved, live)   — board-state.compareBoard
 *   onMismatch(sid, list)  — the health event
 *   settle(ms)             — a delay (injected so tests do not wait)
 */
async function syncBoardOnConnect({ cmd, queue, stations, readSaved, compare, onMismatch, onMatch, log, settle, settleMs = 1500, attempts = 4 }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  let applied = null;
  try { applied = await cmd("applySavedBoard", { reason: "app connect" }); }
  catch (e) { say(`[board] saved board NOT re-applied on connect ✗ ${e && e.message || e}`); }
  if (Array.isArray(applied)) {
    const bad = applied.filter(r => r && r.ok === false);
    say(`[board] saved board re-applied on connect: ${applied.length} station(s)` + (bad.length ? `, ✗ ${bad.map(r => `s${r.stationId}: ${(r.failed || []).map(f => f.setting).join(",") || r.reason}`).join("; ")}` : ""));
  }
  try { await queue.flush((c, a) => cmd(c, a)); } catch (e) { say(`[board] queue flush ✗ ${e && e.message || e}`); }
  if (settle) await settle(settleMs);
  const verdicts = [];
  for (const sid of stations()) {
    let saved;
    try { saved = readSaved(sid); } catch (e) { say(`[board] s${sid} saved board unreadable ✗ ${e && e.message || e}`); continue; }
    // The audio callback adopts a block at the top of its next buffer once its output is open — on a cold open that is
    // a moment after the control copy. Re-read a few times before calling it a mismatch; the LAST read is the verdict.
    let diffs = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      let live;
      try { live = await cmd("getBoardState", { stationId: sid }); } catch (e) { live = { ok: false, reason: String(e && e.message || e) }; }
      diffs = compare(saved, live);
      if (!diffs.length) break;
      if (attempt < attempts - 1 && settle) await settle(settleMs);
    }
    verdicts.push({ stationId: sid, mismatches: diffs });
    if (diffs.length) { say(`[board] s${sid} LIVE ≠ SAVED: ${diffs.map(d => `${d.setting} saved ${JSON.stringify(d.saved)} live ${JSON.stringify(d.live)} (${d.where})`).join("; ")}`); try { onMismatch(sid, diffs); } catch {} }
    else { say(`[board] s${sid} live board matches the saved board`); try { if (onMatch) onMatch(sid); } catch {} }
  }
  return verdicts;
}

module.exports = { createBoardQueue, boardSend, syncBoardOnConnect, keyOf };
