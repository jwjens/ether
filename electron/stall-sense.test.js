// electron/stall-sense.test.js — the attribution arithmetic of the stall sense (docs/perf-pass-round2-2026-10-12.md §1).
// The real-profiler behaviour is proven in Electron by scripts/smoke-stall-sense.js; this pins the counting rules.
import { describe, it, expect } from "vitest";
const { attribute } = require("./stall-sense");

// A tiny V8-shaped profile: root → timerTick (electron/main.js) → readAll (electron/x.js) → (program); plus idle.
const cf = (functionName, url = "", lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: "0" });
const profile = {
  startTime: 0,
  nodes: [
    { id: 1, callFrame: cf("(root)"), children: [2, 5, 6] },
    { id: 2, callFrame: cf("timerTick", "file:///C:/app/electron/main.js", 99), children: [3] },
    { id: 3, callFrame: cf("readAll", "file:///C:/app/electron/x.js", 9), children: [4] },
    { id: 4, callFrame: cf("all", "node:sqlite", 0), children: [] },
    { id: 5, callFrame: cf("(idle)"), children: [] },
    { id: 6, callFrame: cf("(program)"), children: [] },
  ],
  // 10 ms apart (µs deltas): idle, idle, then 30 samples in readAll→all, then idle.
  samples: [5, 5, ...Array(30).fill(4), 5, 5],
  timeDeltas: Array(34).fill(10_000),
};

describe("stall attribution", () => {
  it("names the innermost Ether frames (innermost first) and the leaf, in ms of real sample spacing", () => {
    const a = attribute(profile, 0, 25, 330, 10);
    expect(a.samples).toBe(30);
    expect(a.heldBy[0]).toMatch(/^readAll electron\/x\.js:10 ← timerTick electron\/main\.js:100 ~300 ms$/);
    expect(a.leaf[0]).toMatch(/^all node:sqlite:1 ~300 ms$/);
  });
  it("counts only samples inside the stall window, and never idle", () => {
    expect(attribute(profile, 0, 0, 20, 10).samples).toBe(0);
    expect(attribute(profile, 0, 100, 150, 10).samples).toBe(6);
  });
  it("says so when no Ether frame is on the stack", () => {
    const p = { ...profile, samples: [5, 5, ...Array(30).fill(6), 5, 5] };
    expect(attribute(p, 0, 25, 330, 10).heldBy[0]).toMatch(/^\(no Ether frame on the stack\)/);
  });
});
