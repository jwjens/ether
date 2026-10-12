// electron/perf-sense.js — HOW RESPONSIVE IS ETHER, AND WHAT BLOCKED IT (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Jeff: measure "main-process event-loop lag peak, renderer long
// tasks, and first-click response time. Target: no 'Not Responding', no input delay over one frame." Built in, not a
// trace someone has to take: every number is on /health (127.0.0.1:3400) and a main stall names what held it.
//   · MAIN — every ipcMain handler's synchronous part is timed; one that holds main ≥ 50 ms is recorded with its channel.
//     When the event-loop meter sees a stall ≥ 250 ms, the ledger gets a `main-stall` line naming the slowest handlers
//     seen in that window (or "no IPC handler — a timer or an event did it").
//   · RENDERER — each window reports its long tasks (≥ 50 ms, PerformanceObserver "longtask") and its input timing
//     (Event Timing: delay before the handler ran, and the full input → next paint), every 5 s (src/lib/perfSense.ts).
// Windows of 60 s, like eventLoopLagPeakMs.
"use strict";

const WINDOW_MS = 60_000;

function createPerfSense({ now = () => Date.now(), ledger } = {}) {
  const mainSlow = [];          // { channel, ms, at }
  const renderers = new Map();  // webContents id → { label, longTasks: [{at, ms}], inputs: [{at, type, delay, dur}], firstInput }
  let lastStallLedgerAt = 0;
  const trim = (arr, t) => { while (arr.length && t - arr[0].at > WINDOW_MS) arr.shift(); };

  function noteMain(channel, ms) {
    const t = now(); mainSlow.push({ channel: String(channel), ms: Math.round(ms), at: t });
    if (mainSlow.length > 500) mainSlow.shift();
    trim(mainSlow, t);
  }

  /** Wrap ipcMain so every handler's synchronous part is timed (call once, before handlers register). */
  function instrumentIpc(ipcMain) {
    const { performance } = require("perf_hooks");
    const timed = (channel, fn) => function (...args) {
      const t0 = performance.now();
      try { return fn.apply(this, args); }
      finally { const ms = performance.now() - t0; if (ms >= 50) noteMain(channel, ms); }
    };
    const h = ipcMain.handle.bind(ipcMain), o = ipcMain.on.bind(ipcMain);
    ipcMain.handle = (channel, fn) => h(channel, timed(channel, fn));
    ipcMain.on = (channel, fn) => o(channel, timed(channel, fn));
  }

  /** The event-loop meter saw `lagMs`: a stall ≥ 250 ms goes to the ledger with what was running. */
  function noteLag(lagMs) {
    const t = now();
    if (lagMs < 250 || t - lastStallLedgerAt < 10_000) return;
    lastStallLedgerAt = t;
    const recent = mainSlow.filter(x => t - x.at <= lagMs + 2000).sort((a, b) => b.ms - a.ms).slice(0, 5);
    try {
      if (ledger) ledger("main-stall", { lagMs: Math.round(lagMs), heldBy: recent.length ? recent.map(r => `${r.channel} ${r.ms} ms`) : ["no IPC handler — a timer or an event held main"] });
    } catch { /* a sense never breaks the loop it watches */ }
  }

  function report(id, p) {
    if (!p || typeof p !== "object") return;
    const t = now();
    let r = renderers.get(id);
    if (!r) { r = { label: String(p.label || id), longTasks: [], inputs: [], firstInput: null }; renderers.set(id, r); }
    r.label = String(p.label || r.label);
    for (const x of (Array.isArray(p.longTasks) ? p.longTasks : []).slice(0, 200)) r.longTasks.push({ at: Number(x.at) || t, ms: Math.round(Number(x.ms) || 0) });
    for (const x of (Array.isArray(p.inputs) ? p.inputs : []).slice(0, 200)) r.inputs.push({ at: Number(x.at) || t, type: String(x.type || ""), delay: Math.round(Number(x.delay) || 0), dur: Math.round(Number(x.dur) || 0) });
    if (p.firstInput && !r.firstInput) r.firstInput = { type: String(p.firstInput.type || ""), delay: Math.round(Number(p.firstInput.delay) || 0), dur: Math.round(Number(p.firstInput.dur) || 0) };
    trim(r.longTasks, t); trim(r.inputs, t);
  }
  function forget(id) { renderers.delete(id); }

  function snapshot() {
    const t = now();
    trim(mainSlow, t);
    const out = {
      windowSec: WINDOW_MS / 1000,
      mainSlowHandlers: [...mainSlow].sort((a, b) => b.ms - a.ms).slice(0, 5).map(x => ({ channel: x.channel, ms: x.ms, agoSec: Math.round((t - x.at) / 1000) })),
      renderers: [],
    };
    for (const r of renderers.values()) {
      trim(r.longTasks, t); trim(r.inputs, t);
      const max = (a, f) => a.reduce((m, x) => Math.max(m, f(x)), 0);
      out.renderers.push({
        window: r.label,
        longTasks: r.longTasks.length,
        longTaskPeakMs: max(r.longTasks, x => x.ms),
        inputs: r.inputs.length,
        inputDelayPeakMs: max(r.inputs, x => x.delay),         // input → its handler starting
        inputResponsePeakMs: max(r.inputs, x => x.dur),        // input → the next frame painted
        inputsOverOneFrame: r.inputs.filter(x => x.dur > 17).length,
        firstInput: r.firstInput,                              // the window's first click/key since it opened
      });
    }
    return out;
  }

  return { instrumentIpc, noteMain, noteLag, report, forget, snapshot };
}

module.exports = { createPerfSense };
