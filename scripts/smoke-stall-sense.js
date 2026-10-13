// scripts/smoke-stall-sense.js — the stall sense names what held main, in a REAL Electron main process (2026-10-12).
//
// docs/perf-pass-round2-2026-10-12.md. Runs as Electron's main process (not ELECTRON_RUN_AS_NODE: the profiler has to
// work where Ether's main runs):   npx electron scripts/smoke-stall-sense.js
// Plants blocks of known length in code that lives in an `electron/` folder (so it counts as Ether's own code):
//   A · 300 ms inside a TIMER callback (what the old sense could only call "a timer or an event");
//   B · 250 ms inside an async function AFTER an await (a continuation — no timer, no IPC on the stack);
//   C · 60 ms (under the 100 ms threshold — must NOT be counted).
// PASS = A and B are each reported once with the right function and file, C is not, and the sense's own cut is cheap.
"use strict";
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stall-sense-"));
fs.mkdirSync(path.join(TMP, "electron"));
fs.writeFileSync(path.join(TMP, "electron", "blocker.js"), `
function spin(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* hold main */ } }
function timerWork(ms) { spin(ms); }
async function afterAwaitWork(ms) { await new Promise(r => setTimeout(r, 5)); spin(ms); }
module.exports = { timerWork, afterAwaitWork, spin };
`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ledgered = [];
  const sense = require("../electron/stall-sense").createStallSense({ armMs: 4000, ledger: (k, d) => ledgered.push(d) });
  sense.start();
  const B = require(path.join(TMP, "electron", "blocker.js"));
  await sleep(400);
  ok(sense.snapshot().profiler === "ready", `healthy: the profiler is NOT running before any stall (${sense.snapshot().profiler})`);
  setTimeout(() => B.spin(200), 10);                 // the first stall arms the profiler
  await sleep(500);
  ok(sense.snapshot().profiler === "armed", `the first stall armed the profiler (${sense.snapshot().profiler})`);
  setTimeout(() => B.timerWork(300), 10);
  await sleep(900);
  B.afterAwaitWork(250);
  await sleep(900);
  setTimeout(() => B.spin(60), 10);
  await sleep(2200);                                  // the 4 s armed window ends: one cut
  const s = sense.snapshot();
  console.log(JSON.stringify(s, null, 2));
  ok(s.profiler === "ready", `after the window the profiler is off again (${s.profiler}); one cut, ${s.cutMsRecent.join(", ")} ms`);
  ok(s.stallsTotal === 3, `exactly three stalls ≥ 100 ms counted (got ${s.stallsTotal}); the 60 ms block is not one`);
  ok(/first stall: the profiler is now armed/.test(((s.stalls[0] || {}).heldBy || [])[0] || ""), `the first stall says it armed the profiler: ${(s.stalls[0] || {}).heldBy}`);
  const [, a, b] = s.stalls;
  ok(a && a.lagMs >= 250 && /^(spin electron\/blocker\.js:2 ← )?timerWork electron\/blocker\.js:3 /.test(a.heldBy[0] || ""), `A · the 300 ms timer block is named: ${a && a.lagMs} ms — ${a && a.heldBy.join("; ")}`);
  ok(b && b.lagMs >= 200 && /^afterAwaitWork electron\/blocker\.js:4 /.test(b.heldBy[0] || ""), `B · the 250 ms block after an await is named: ${b && b.lagMs} ms — ${b && b.heldBy.join("; ")}`);
  ok(ledgered.some(l => /timerWork/.test((l.heldBy || [])[0] || "")) && ledgered.some(l => /afterAwaitWork/.test((l.heldBy || [])[0] || "")), `the ledger names both causes: ${ledgered.map(l => l.heldBy[0]).join(" | ")}`);
  ok(s.cutMsPeak < 100, `the one cut costs ${s.cutMsPeak} ms (under the 100 ms stall threshold, and only paid while stalls are happening)`);
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
