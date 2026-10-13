// electron/stall-sense.js — EVERY MAIN-PROCESS STALL ≥ 100 ms, AND THE CODE THAT HELD IT (2026-10-12).
//
// docs/perf-pass-round2-2026-10-12.md. Jeff: "Give the stall sense timer attribution, then name and fix the ~30 s timer
// stalls." The first sense (electron/perf-sense.js) only timed IPC handlers, so ten 0.3–0.8 s stalls on OVEVENTS could
// only be reported as "no IPC handler — a timer or an event held main". This one names the code, whatever started it:
//   · A 50 ms self-timer. Any block of B ms delays its next tick by at least B − 50 ms, so every stall ≥ 100 ms is seen
//     (the 1 s lag meter in main.js misses a block that starts and ends between two of its ticks).
//   · V8's sampling profiler, always on, through the in-process inspector (no port, no flag): every 4 ms it records the
//     main thread's JS stack. When a stall is seen, the profile is cut, the samples INSIDE the stall are counted, and
//     the stall is named by the innermost frame of Ether's own code (electron/, audiod/) plus the leaf function —
//     a timer callback, an await continuation, a spawn, a synchronous SQLite call: whatever ran.
// The profiler is ARMED by a stall rather than always on (a cut costs main 60-90 ms, see arm()); the sense times its
// own cut (`cutMsPeak`) so its cost is on /health too. If the inspector is unavailable the stalls are still counted and
// reported as unattributed, with the reason; the sense never pretends.
"use strict";

const { performance } = require("perf_hooks");

const KEEP_MS = 60_000;

function frameLabel(cf) {
  const fn = cf.functionName || "(anonymous)";
  if (!cf.url) return fn;
  const file = String(cf.url).replace(/^file:\/+/, "").split(/[\\/]/).slice(-2).join("/");
  return `${fn} ${file}:${(cf.lineNumber | 0) + 1}`;
}
const OURS = /[\\/](electron|audiod)[\\/][^\\/]+\.js$/;
const isOurs = (cf) => !!cf.url && OURS.test(String(cf.url)) && !/node_modules/.test(String(cf.url));

/** Count what ran inside [fromPerf, toPerf] in a V8 CPU profile whose startTime maps to `startPerf`. Pure (tested). */
function attribute(profile, startPerf, fromPerf, toPerf, sampleMs) {
  const nodes = new Map(), parent = new Map();
  for (const n of profile.nodes || []) { nodes.set(n.id, n); for (const c of n.children || []) parent.set(c, n.id); }
  const ours = new Map(), leaf = new Map();
  const add = (m, k, ms) => m.set(k, (m.get(k) || 0) + ms);
  let t = profile.startTime, counted = 0;
  const samples = profile.samples || [], deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] || 0;
    const at = startPerf + (t - profile.startTime) / 1000;
    if (at < fromPerf || at > toPerf) continue;
    const n = nodes.get(samples[i]); if (!n) continue;
    const name = n.callFrame.functionName;
    if (name === "(idle)" || name === "(root)") continue;
    counted++;
    // A sample stands for the time until the next one (the real spacing — Windows samples coarser than asked).
    const ms = i + 1 < samples.length ? Math.min((deltas[i + 1] || 0) / 1000, 50) : sampleMs;
    add(leaf, frameLabel(n.callFrame), ms);
    // The innermost Ether frames, up to three, innermost first: "spin electron/x.js:2 ← timerWork electron/x.js:3".
    const chain = [];
    for (let id = n.id; id != null && chain.length < 3; id = parent.get(id)) { const x = nodes.get(id); if (x && isOurs(x.callFrame)) chain.push(frameLabel(x.callFrame)); }
    add(ours, chain.length ? chain.join(" ← ") : "(no Ether frame on the stack)", ms);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${k} ~${Math.round(ms)} ms`);
  return { samples: counted, heldBy: top(ours, 3), leaf: top(leaf, 3) };
}

function createStallSense({ tickMs = 50, thresholdMs = 100, sampleUs = 4000, armMs = 60_000, ledger, ipcRecent, now = () => Date.now() } = {}) {
  const startedAt = now();
  const seen = [];            // { at, lagMs } — every stall, the moment it is seen (counts never wait for attribution)
  const stalls = [];          // { at, lagMs, heldBy, leaf, ipc, samples, sinceLaunchSec } — attributed, last 5 min
  const pending = [];         // stalls inside the armed window, waiting for the cut
  let total = 0, cutMsPeak = 0, arms = 0;
  const ledgeredAt = new Map(); // cause → last ledger time: one line per distinct cause per minute, so a recurring stall
                                // cannot flood the ledger and a different cause is never hidden behind it
  const cutMs = [];           // the sense's own cost: the last cuts (profile stop + attribution), ms
  let session = null, profiling = false, profStartPerf = 0, profStatus = "off", cutTimer = null;

  function settle(list, attr, why) {
    for (const s of list) {
      const a = attr ? attr(s) : { samples: 0, heldBy: [], leaf: [] };
      const ipc = ipcRecent ? ipcRecent(s.endWall, s.lagMs) : [];
      const heldBy = a.heldBy.length ? a.heldBy : ipc.length ? ipc : [`unattributed — ${why || `profiler ${profStatus}`}`];
      const rec = { at: s.endWall, lagMs: s.lagMs, heldBy, leaf: a.leaf, ipc, samples: a.samples, sinceLaunchSec: Math.round((s.endWall - startedAt) / 1000) };
      stalls.push(rec);
      const cause = String(heldBy[0] || "").replace(/ ~\d+ ms$/, "");
      if (rec.at - (ledgeredAt.get(cause) || 0) >= 60_000) {
        ledgeredAt.set(cause, rec.at);
        if (ledgeredAt.size > 100) ledgeredAt.delete(ledgeredAt.keys().next().value);
        try { if (ledger) ledger("main-stall", { lagMs: rec.lagMs, at: new Date(rec.at).toISOString(), heldBy: rec.heldBy, leaf: rec.leaf, ipc: rec.ipc }); } catch { /* a sense never breaks what it watches */ }
      }
    }
    const t = now(); while (stalls.length && t - stalls[0].at > KEEP_MS * 5) stalls.shift();
    if (stalls.length > 200) stalls.splice(0, stalls.length - 200);
  }

  // ARMED, NOT ALWAYS ON. Cutting a V8 profile costs main ~60-90 ms (measured in Electron 43, scripts/smoke-stall-sense.js),
  // so a healthy app must not pay it on a timer. The profiler starts at the first stall and records for `armMs`; every
  // stall inside that window is attributed in ONE cut at its end. A recurring stall is named from its second
  // occurrence; a one-off first stall is reported with the IPC handlers seen, or as unattributed with the reason.
  function arm() {
    if (!session || profiling) return;
    try {
      session.post("Profiler.start");
      profStartPerf = performance.now(); profiling = true; arms++;
      cutTimer = setTimeout(cut, armMs);
      if (cutTimer.unref) cutTimer.unref();
    } catch (e) { profStatus = `unavailable: ${e.message}`; profiling = false; }
  }

  /** End the armed window: stop the profile, attribute every stall inside it. */
  function cut() {
    if (cutTimer) { clearTimeout(cutTimer); cutTimer = null; }
    const list = pending.splice(0);
    if (!session || !profiling) { settle(list, null); return; }
    const t0 = performance.now(), startPerf = profStartPerf;
    profiling = false;
    try {
      session.post("Profiler.stop", (err, res) => {
        if (err || !res || !res.profile) { settle(list, null); return; }
        const sampleMs = sampleUs / 1000;
        settle(list, (s) => attribute(res.profile, startPerf, s.endPerf - s.lagMs - tickMs - sampleMs, s.endPerf, sampleMs));
        const ms = Math.round(performance.now() - t0); if (ms > cutMsPeak) cutMsPeak = ms;
        cutMs.push(ms); if (cutMs.length > 10) cutMs.shift();
      });
    } catch (e) { profStatus = `unavailable: ${e.message}`; settle(list, null); }
  }

  function start() {
    try {
      const inspector = require("inspector");
      session = new inspector.Session();
      session.connect();
      session.post("Profiler.enable");
      session.post("Profiler.setSamplingInterval", { interval: sampleUs });
      profStatus = "ready";
    } catch (e) { session = null; profStatus = `unavailable: ${e && e.message}`; }
    let expected = performance.now() + tickMs;
    const meter = setInterval(() => {
      const p = performance.now(), lag = p - expected;
      expected = p + tickMs;
      if (lag < thresholdMs) return;
      total++;
      const st = { endPerf: p, endWall: now(), lagMs: Math.round(lag) };
      seen.push({ at: st.endWall, lagMs: st.lagMs }); if (seen.length > 500) seen.shift();
      if (profiling) pending.push(st);
      else { settle([st], null, "first stall: the profiler is now armed for the next " + Math.round(armMs / 1000) + " s"); arm(); }
    }, tickMs);
    if (meter.unref) meter.unref();
  }

  function snapshot() {
    const t = now();
    const recent = seen.filter(s => t - s.at <= KEEP_MS);
    return {
      profiler: profiling ? "armed" : profStatus,
      thresholdMs,
      stallsTotal: total,
      stallsLast60s: recent.length,
      worstLast60sMs: recent.reduce((m, s) => Math.max(m, s.lagMs), 0),
      armedTimes: arms,
      cutMsPeak,
      cutMsRecent: [...cutMs],
      stalls: stalls.slice(-30),       // attributed, last 5 minutes (a stall is attributed when its armed window ends)
    };
  }

  return { start, snapshot, _cut: cut };
}

module.exports = { createStallSense, attribute };
