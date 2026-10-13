// src/lib/perfSense.ts — the renderer half of the responsiveness sense (2026-10-12; main half: electron/perf-sense.js).
//
// Every window reports, every 5 s, its LONG TASKS (≥ 50 ms of script/layout that blocks input) and its INPUT TIMING —
// for each click/key: how long before its handler ran, and how long until the next frame was painted (Event Timing API).
// Observing costs nothing measurable; the report is one small IPC every 5 s. The numbers are on /health.
//
// ROUND 2 (docs/perf-pass-round2-2026-10-12.md §3) — WHAT made the frame slow, not only that it was:
//   · LONG ANIMATION FRAMES (Chromium's long-animation-frame entries): every frame ≥ 50 ms with its style/layout/paint
//     time and the scripts that ran in it (invoker, function, duration, forced layout). NOTE: Chromium withholds the
//     script list for a file:// page (measured 2026-10-12), which is how the packaged app loads — so in the field the
//     REACT breakdown below is what names the work, and `scripts` fills in only where the page has a real origin.
//   · REACT COMMITS (reactCommit, the onRender of the <Profiler> around every window's root; the build uses React's
//     profiling renderer): every commit over one frame is broken down by COMPONENT — the self time of each component
//     rendered in that commit — so "the click took 288 ms" becomes "LivePanel 140 ms, DeckStrip 60 ms".
type LT = { at: number; ms: number };
type IN = { at: number; type: string; delay: number; dur: number };
type SCRIPT = { invoker: string; fn: string; src: string; ms: number; layoutMs: number };
type LF = { at: number; ms: number; blockingMs: number; renderMs: number; layoutMs: number; scripts: SCRIPT[] };
type SCROLL = { at: number; el: string; from: number; to: number; n: number };
type COMMIT = { at: number; ms: number; phase: string; top: { name: string; ms: number }[] };

import { ownFeedScrolls } from "./stickyScroll";

const INPUT_TYPES = new Set(["pointerdown", "pointerup", "click", "mousedown", "mouseup", "keydown", "keyup"]);
let started = false;
const commits: COMMIT[] = [];
let lastWalkAt = 0;

const wall = (perfT: number) => Math.round(performance.timeOrigin + perfT);

// ── React: who rendered, for how long ────────────────────────────────────────────────────────────────────────────
// Fiber tags (React 18): Function 0, Class 1, ForwardRef 11, Memo 14, SimpleMemo 15. A fiber rendered IN THIS COMMIT has
// actualStartTime ≥ the commit's render start; a fiber cloned on the path but not rendered has −1. Anything else is a
// subtree React reused untouched, and is skipped — so the walk visits only what this commit did.
function fiberName(f: any): string | null {
  const t = f && f.type;
  switch (f && f.tag) {
    case 0: case 1: case 15: return (t && (t.displayName || t.name)) || "(anonymous)";
    case 11: return (t && (t.displayName || (t.render && (t.render.displayName || t.render.name)))) || "ForwardRef";
    case 14: return (t && (t.displayName || (t.type && (t.type.displayName || t.type.name)))) || "Memo";
    default: return null;
  }
}
function walkCommit(startTime: number): { name: string; ms: number }[] {
  const rootEl = document.getElementById("root") as any;
  if (!rootEl) return [];
  const key = Object.keys(rootEl).find(k => k.startsWith("__reactContainer$"));
  const hostRoot = key ? rootEl[key] : null;
  const cur = hostRoot && hostRoot.stateNode && hostRoot.stateNode.current;
  if (!cur) return [];
  const inCommit = (f: any) => f.actualStartTime === -1 || f.actualStartTime >= startTime - 0.5;
  const self = new Map<string, number>();
  const stack: { f: any; owner: string }[] = [{ f: cur, owner: "(root)" }];
  let visited = 0;
  while (stack.length && visited < 30000) {
    const { f, owner } = stack.pop()!;
    visited++;
    const name = fiberName(f) || owner;
    let kids = 0;
    for (let c = f.child; c; c = c.sibling) {
      if (!inCommit(c)) continue;
      kids += c.actualDuration || 0;
      stack.push({ f: c, owner: name });
    }
    if (f.actualStartTime >= startTime - 0.5) {
      const ms = Math.max(0, (f.actualDuration || 0) - kids);
      if (ms > 0) self.set(name, (self.get(name) || 0) + ms);
    }
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, ms]) => ({ name, ms: Math.round(ms * 10) / 10 }));
}

/** <Profiler onRender={reactCommit}>: a commit over one frame is broken down by component (at most one walk per 250 ms). */
export function reactCommit(_id: string, phase: string, actualDuration: number, _base: number, startTime: number, commitTime: number) {
  if (actualDuration < 16) return;
  const at = wall(commitTime);
  let top: { name: string; ms: number }[] = [];
  const now = performance.now();
  if (now - lastWalkAt >= 250) { lastWalkAt = now; try { top = walkCommit(startTime); } catch { top = []; } }
  commits.push({ at, ms: Math.round(actualDuration), phase, top });
  if (commits.length > 200) commits.shift();
}

export function startPerfSense(label: string) {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;
  const longTasks: LT[] = [], inputs: IN[] = [], frames: LF[] = [], scrolls: SCROLL[] = [];
  // UNPROMPTED SCROLLS (round 2 §5, Jeff: the Health Monitor "never … scrolls … by itself"): a scroll of any element
  // with no wheel / key / pointer / touch input in this window in the second before it, that is not a feed following
  // its own box (stickyScroll.ts ownFeedScrolls), is reported with the element. Over a long session an empty list is
  // the receipt. (A list that SHRINKS can clamp its own scrollTop with nobody touching it — reported too, and named.)
  try {
    let lastInput = -1e9;   // no input yet: a scroll in the page's first second is not the operator's
    const markInput = () => { lastInput = performance.now(); };
    for (const t of ["wheel", "keydown", "pointerdown", "touchstart", "mousedown"]) document.addEventListener(t, markInput, { capture: true, passive: true });
    const lastTop = new WeakMap<Element, number>();
    const describe = (el: Element) => {
      const h = el as HTMLElement, cls = typeof h.className === "string" ? h.className.trim().split(/\s+/)[0] : "";
      const near = h.closest?.("[data-panel],[aria-label],[title]") as HTMLElement | null;
      const where = near ? (near.getAttribute("data-panel") || near.getAttribute("aria-label") || near.getAttribute("title") || "") : "";
      return `${el === document.scrollingElement ? "page" : h.tagName.toLowerCase()}${h.id ? "#" + h.id : ""}${cls ? "." + cls : ""}${where ? ` in "${where.slice(0, 40)}"` : ""}`;
    };
    document.addEventListener("scroll", (e) => {
      const el = (e.target === document ? document.scrollingElement : e.target) as Element | null;
      if (!el) return;
      const top = (el as HTMLElement).scrollTop, from = lastTop.get(el) ?? 0;   // an element starts at the top
      lastTop.set(el, top);
      const now = performance.now();
      if (now - lastInput < 1000) return;                               // the operator's scroll
      if (now - (ownFeedScrolls.get(el) ?? -1e9) < 250) return;          // a feed following its own box
      if (Math.abs(top - from) < 2) return;
      // One row per element per report (count + first position + last), so a frequent offender cannot push a rare one out.
      const d = describe(el), row = scrolls.find(x => x.el === d);
      if (row) { row.n++; row.to = top; }
      else if (scrolls.length < 50) scrolls.push({ at: wall(now), el: d, from, to: top, n: 1 });
    }, { capture: true, passive: true });
  } catch { /* never block the window */ }
  let firstInput: { type: string; delay: number; dur: number } | null = null;
  let firstSent = false;
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
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries() as any[]) {
        if (e.duration < 50) continue;
        const end = e.startTime + e.duration;
        const scripts: SCRIPT[] = (e.scripts || [])
          .map((s: any) => ({
            invoker: String(s.invoker || s.invokerType || ""),
            fn: String(s.sourceFunctionName || ""),
            src: String(s.sourceURL || "").split("/").pop() + (s.sourceCharPosition >= 0 ? `@${s.sourceCharPosition}` : ""),
            ms: Math.round(s.duration),
            layoutMs: Math.round(s.forcedStyleAndLayoutDuration || 0),
          }))
          .sort((a: SCRIPT, b: SCRIPT) => b.ms - a.ms).slice(0, 4);
        frames.push({
          at: wall(e.startTime), ms: Math.round(e.duration), blockingMs: Math.round(e.blockingDuration || 0),
          renderMs: e.renderStart ? Math.round(end - e.renderStart) : 0,
          layoutMs: e.styleAndLayoutStart ? Math.round(end - e.styleAndLayoutStart) : 0,
          scripts,
        });
        if (frames.length > 200) frames.shift();
      }
    }).observe({ type: "long-animation-frame", buffered: true } as any);
  } catch { /* not supported */ }
  setInterval(() => {
    if (!longTasks.length && !inputs.length && !frames.length && !commits.length && !scrolls.length && (firstSent || !firstInput)) return;
    const payload = { label, longTasks: longTasks.splice(0), inputs: inputs.splice(0), frames: frames.splice(0), commits: commits.splice(0), scrolls: scrolls.splice(0),
                      firstInput: firstSent ? null : firstInput };
    if (firstInput) firstSent = true;
    try { (window as any).ether?.invoke?.("perf:report", payload); } catch { /* bridge absent */ }
  }, 5000);
}
