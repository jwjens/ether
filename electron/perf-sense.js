// electron/perf-sense.js — HOW RESPONSIVE IS ETHER, AND WHAT BLOCKED IT (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Jeff: measure "main-process event-loop lag peak, renderer long
// tasks, and first-click response time. Target: no 'Not Responding', no input delay over one frame." Built in, not a
// trace someone has to take: every number is on /health (127.0.0.1:3400) and a main stall names what held it.
//   · MAIN — every ipcMain handler's synchronous part is timed; one that holds main ≥ 50 ms is recorded with its channel.
//     Every main stall ≥ 100 ms is caught and named by electron/stall-sense.js (round 2: a 50 ms meter plus V8's sampling
//     profiler, so a timer, an await continuation or an event is named by its code, not "a timer or an event"); the
//     IPC handlers seen are kept beside it. The ledger's `main-stall` lines come from there.
//   · RENDERER — each window reports its long tasks (≥ 50 ms, PerformanceObserver "longtask") and its input timing
//     (Event Timing: delay before the handler ran, and the full input → next paint), every 5 s (src/lib/perfSense.ts).
// Windows of 60 s, like eventLoopLagPeakMs.
"use strict";

const WINDOW_MS = 60_000;

function createPerfSense({ now = () => Date.now(), ledger } = {}) {
  const stallSense = require("./stall-sense").createStallSense({ ledger, now, ipcRecent: (at, lagMs) => ipcRecent(at, lagMs) });
  const mainSlow = [];          // { channel, ms, at }
  const renderers = new Map();  // webContents id → { label, longTasks: [{at, ms}], inputs: [{at, type, delay, dur}], firstInput }
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

  /** The IPC handlers that held main in the 2 s around a stall that ended at `at` (the stall sense's fallback names). */
  function ipcRecent(at, lagMs) {
    return mainSlow.filter(x => x.at <= at + 100 && x.at >= at - lagMs - 2000).sort((a, b) => b.ms - a.ms).slice(0, 3).map(r => `ipc ${r.channel} ${r.ms} ms`);
  }
  /** The 1 s lag meter in main.js (kept for eventLoopLagMs/PeakMs). The ledger lines now come from the stall sense. */
  function noteLag(_lagMs) { /* see stall-sense.js */ }

  function report(id, p) {
    if (!p || typeof p !== "object") return;
    const t = now();
    let r = renderers.get(id);
    if (!r) { r = { label: String(p.label || id), longTasks: [], inputs: [], frames: [], commits: [], scrolls: [], firstInput: null }; renderers.set(id, r); }
    r.label = String(p.label || r.label);
    for (const x of (Array.isArray(p.longTasks) ? p.longTasks : []).slice(0, 200)) r.longTasks.push({ at: Number(x.at) || t, ms: Math.round(Number(x.ms) || 0) });
    for (const x of (Array.isArray(p.inputs) ? p.inputs : []).slice(0, 200)) r.inputs.push({ at: Number(x.at) || t, type: String(x.type || ""), delay: Math.round(Number(x.delay) || 0), dur: Math.round(Number(x.dur) || 0) });
    // Round 2: long animation frames with their scripts, and slow React commits broken down by component (src/lib/perfSense.ts).
    const str = (v, n) => String(v == null ? "" : v).slice(0, n);
    for (const x of (Array.isArray(p.frames) ? p.frames : []).slice(0, 100)) r.frames.push({
      at: Number(x.at) || t, ms: Math.round(Number(x.ms) || 0), blockingMs: Math.round(Number(x.blockingMs) || 0),
      renderMs: Math.round(Number(x.renderMs) || 0), layoutMs: Math.round(Number(x.layoutMs) || 0),
      scripts: (Array.isArray(x.scripts) ? x.scripts : []).slice(0, 4).map(sc => ({ invoker: str(sc.invoker, 80), fn: str(sc.fn, 80), src: str(sc.src, 80), ms: Math.round(Number(sc.ms) || 0), layoutMs: Math.round(Number(sc.layoutMs) || 0) })),
    });
    for (const x of (Array.isArray(p.commits) ? p.commits : []).slice(0, 100)) r.commits.push({
      at: Number(x.at) || t, ms: Math.round(Number(x.ms) || 0), phase: str(x.phase, 12),
      top: (Array.isArray(x.top) ? x.top : []).slice(0, 6).map(c => ({ name: str(c.name, 60), ms: Number(c.ms) || 0 })),
    });
    for (const x of (Array.isArray(p.scrolls) ? p.scrolls : []).slice(0, 50)) {     // unprompted scrolls (round 2 §5), kept 30 min
      r.scrolls.push({ at: Number(x.at) || t, window: r.label, el: str(x.el, 120), from: Math.round(Number(x.from) || 0), to: Math.round(Number(x.to) || 0), n: Math.round(Number(x.n) || 1) });
      if (r.scrolls.length > 100) r.scrolls.shift();
    }
    if (p.firstInput && !r.firstInput) r.firstInput = { type: String(p.firstInput.type || ""), delay: Math.round(Number(p.firstInput.delay) || 0), dur: Math.round(Number(p.firstInput.dur) || 0) };
    trim(r.longTasks, t); trim(r.inputs, t); trim(r.frames, t); trim(r.commits, t);
  }
  function forget(id) { renderers.delete(id); }
  /** Every window's unprompted scrolls in the last 30 minutes (electron/self-action-sense.js shows them beside its own). */
  function rendererScrolls() {
    const t = now(), out = [];
    for (const r of renderers.values()) for (const x of r.scrolls || []) if (t - x.at <= 30 * 60_000) out.push(x);
    return out.sort((a, b) => a.at - b.at).slice(-20);
  }

  function snapshot() {
    const t = now();
    trim(mainSlow, t);
    const out = {
      windowSec: WINDOW_MS / 1000,
      mainStalls: stallSense.snapshot(),
      mainSlowHandlers: [...mainSlow].sort((a, b) => b.ms - a.ms).slice(0, 5).map(x => ({ channel: x.channel, ms: x.ms, agoSec: Math.round((t - x.at) / 1000) })),
      renderers: [],
    };
    for (const r of renderers.values()) {
      trim(r.longTasks, t); trim(r.inputs, t); trim(r.frames, t); trim(r.commits, t);
      const byComponent = new Map();
      for (const c of r.commits) for (const x of c.top) byComponent.set(x.name, (byComponent.get(x.name) || 0) + x.ms);
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
        longFrames: r.frames.length,                           // frames ≥ 50 ms (long-animation-frame)
        longFrameWorst: [...r.frames].sort((a, b) => b.ms - a.ms).slice(0, 3),
        slowCommits: r.commits.length,                         // React commits over one frame
        slowCommitPeakMs: max(r.commits, x => x.ms),
        slowCommitWorst: [...r.commits].sort((a, b) => b.ms - a.ms).slice(0, 3),
        componentSelfMs: [...byComponent].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, ms]) => ({ name, ms: Math.round(ms) })),
      });
    }
    return out;
  }

  return { instrumentIpc, noteMain, noteLag, report, forget, snapshot, rendererScrolls, startStallSense: () => stallSense.start() };
}

module.exports = { createPerfSense };
