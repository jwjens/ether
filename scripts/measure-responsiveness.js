// scripts/measure-responsiveness.js — read Ether's own responsiveness senses for N minutes and summarise (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md §4. READ-ONLY: polls http://127.0.0.1:3400/health every 2 s (the
// endpoint the HA watchdog already polls), and ENDS BY ITSELF after the given minutes. Nothing is left running.
//   node scripts/measure-responsiveness.js <minutes> <label> [out.json]
// Reports: main event-loop lag (peak, stalls ≥ 250 ms / ≥ 1 s, unanswered polls), the slowest main handlers seen, and per
// window: long tasks, the worst long task, inputs over one frame, the worst input delay/response, and the first input.
"use strict";
const http = require("http"), fs = require("fs");
const MIN = Number(process.argv[2] || 5), LABEL = process.argv[3] || "run", OUT = process.argv[4] || null;
const get = () => new Promise((res) => {
  const t0 = Date.now();
  const rq = http.get("http://127.0.0.1:3400/health", { timeout: 4000 }, (r) => { let b = ""; r.on("data", d => b += d); r.on("end", () => { try { res({ ok: true, ms: Date.now() - t0, h: JSON.parse(b) }); } catch { res({ ok: false }); } }); });
  rq.on("timeout", () => { rq.destroy(); res({ ok: false, timeout: true }); }); rq.on("error", () => res({ ok: false }));
});
(async () => {
  const end = Date.now() + MIN * 60_000;
  let polls = 0, answered = 0, worstLag = 0, stalls250 = 0, stalls1s = 0, worstAnswerMs = 0;
  const handlers = new Map(), wins = new Map();
  while (Date.now() < end) {
    polls++;
    const r = await get();
    if (r.ok) {
      answered++; worstAnswerMs = Math.max(worstAnswerMs, r.ms);
      const lag = Number(r.h.eventLoopLagMs) || 0;
      worstLag = Math.max(worstLag, Number(r.h.eventLoopLagPeakMs) || 0, lag);
      if (lag >= 250) stalls250++; if (lag >= 1000) stalls1s++;
      const p = r.h.perf || {};
      for (const x of p.mainSlowHandlers || []) handlers.set(x.channel, Math.max(handlers.get(x.channel) || 0, x.ms));
      for (const w of p.renderers || []) {
        const c = wins.get(w.window) || { longTasksSeen: 0, longTaskPeakMs: 0, inputsOverOneFrame: 0, inputDelayPeakMs: 0, inputResponsePeakMs: 0, firstInput: null };
        c.longTaskPeakMs = Math.max(c.longTaskPeakMs, w.longTaskPeakMs || 0);
        c.longTasksSeen = Math.max(c.longTasksSeen, w.longTasks || 0);           // per 60 s window, the busiest one seen
        c.inputsOverOneFrame = Math.max(c.inputsOverOneFrame, w.inputsOverOneFrame || 0);
        c.inputDelayPeakMs = Math.max(c.inputDelayPeakMs, w.inputDelayPeakMs || 0);
        c.inputResponsePeakMs = Math.max(c.inputResponsePeakMs, w.inputResponsePeakMs || 0);
        if (w.firstInput && !c.firstInput) c.firstInput = w.firstInput;
        wins.set(w.window, c);
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const out = {
    label: LABEL, minutes: MIN, polls, answered, unanswered: polls - answered, worstAnswerMs,
    main: { eventLoopLagPeakMs: worstLag, pollsSeeingLag250: stalls250, pollsSeeingLag1s: stalls1s, slowestHandlers: [...handlers].sort((a, b) => b[1] - a[1]).slice(0, 8) },
    windows: Object.fromEntries(wins),
  };
  console.log(JSON.stringify(out, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
})();
