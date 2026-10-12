// src/lib/perfSense.ts — the renderer half of the responsiveness sense (2026-10-12; main half: electron/perf-sense.js).
//
// Every window reports, every 5 s, its LONG TASKS (≥ 50 ms of script/layout that blocks input) and its INPUT TIMING —
// for each click/key: how long before its handler ran, and how long until the next frame was painted (Event Timing API).
// Observing costs nothing measurable; the report is one small IPC every 5 s. The numbers are on /health.
type LT = { at: number; ms: number };
type IN = { at: number; type: string; delay: number; dur: number };

const INPUT_TYPES = new Set(["pointerdown", "pointerup", "click", "mousedown", "mouseup", "keydown", "keyup"]);
let started = false;

export function startPerfSense(label: string) {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;
  const longTasks: LT[] = [], inputs: IN[] = [];
  let firstInput: { type: string; delay: number; dur: number } | null = null;
  let firstSent = false;
  const wall = (perfT: number) => Math.round(performance.timeOrigin + perfT);
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) longTasks.push({ at: wall(e.startTime), ms: e.duration });
    }).observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
  } catch { /* not supported — the report says 0 */ }
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries() as any[]) {
        if (!INPUT_TYPES.has(e.name)) continue;
        inputs.push({ at: wall(e.startTime), type: e.name, delay: Math.max(0, e.processingStart - e.startTime), dur: e.duration });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as any);
  } catch { /* not supported */ }
  try {
    new PerformanceObserver(list => {
      const e: any = list.getEntries()[0];
      if (e && !firstInput) firstInput = { type: e.name, delay: Math.max(0, e.processingStart - e.startTime), dur: e.duration };
    }).observe({ type: "first-input", buffered: true } as PerformanceObserverInit);
  } catch { /* not supported */ }
  setInterval(() => {
    if (!longTasks.length && !inputs.length && (firstSent || !firstInput)) return;
    const payload = { label, longTasks: longTasks.splice(0), inputs: inputs.splice(0), firstInput: firstSent ? null : firstInput };
    if (firstInput) firstSent = true;
    try { (window as any).ether?.invoke?.("perf:report", payload); } catch { /* bridge absent */ }
  }, 5000);
}
