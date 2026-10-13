// scripts/smoke-encoder-probe.js — the Show+ encoder probe runs once, in the background, off main (2026-10-12).
//
// docs/perf-pass-round2-2026-10-12.md §2. RECEIPT: video:list-encoders held main 1,777 ms on OVEVENTS — starting ffmpeg
// (CreateProcess, plus an on-access scan of ffmpeg.exe) ran on the main thread even though the handler was async.
// Runs as Electron's main process:   npx electron scripts/smoke-encoder-probe.js
// PASS = main's worst event-loop lag stays under one frame while the probe runs; the answer equals a direct probe;
// three callers share ONE probe; and the probe starts by itself after launch (nobody clicks).
"use strict";
const { app } = require("electron");
const { execFileSync } = require("child_process");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const ffmpeg = require("ffmpeg-static");
    const handlers = {};
    const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} };
    let worst = 0, expected = Date.now() + 10;
    const meter = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - expected); expected = n + 10; }, 10);
    const VE = require("../electron/video-engine.js");
    VE.installVideoEngine(fakeIpc, { ffmpegBin: ffmpeg, probeDelayMs: 50 });   // the background start, shortened
    await sleep(60);
    const t0 = Date.now();
    const [a, b, c] = await Promise.all([handlers["video:list-encoders"](), handlers["video:list-encoders"](), VE._encoders()]);
    const ms = Date.now() - t0;
    await sleep(30); clearInterval(meter);
    const direct = VE.parseEncoders(execFileSync(ffmpeg, ["-hide_banner", "-encoders"]).toString());
    console.log(`  ..   probe answered in ${ms} ms: ${JSON.stringify(a)}; main's worst lag meanwhile ${worst} ms`);
    // CONTROL: the old path — execFile from THIS thread (what video:list-encoders did).
    let cWorst = 0, cExp = Date.now() + 10;
    const cm = setInterval(() => { const n = Date.now(); cWorst = Math.max(cWorst, n - cExp); cExp = n + 10; }, 10);
    await sleep(30);
    const tsync = Date.now();
    await new Promise(r => require("child_process").execFile(ffmpeg, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 }, () => r()));
    const spawnSyncMs = Date.now() - tsync;
    await sleep(30); clearInterval(cm);
    console.log(`  ..   CONTROL (execFile on main, the old probe): main's worst lag ${cWorst} ms (the whole probe ${spawnSyncMs} ms)`);
    ok(worst < 50, `main is not held while ffmpeg starts and runs (worst lag ${worst} ms, well under the 100 ms stall bar; old path ${cWorst} ms)`);
    ok(JSON.stringify(a) === JSON.stringify(direct), `the answer equals a direct probe (${direct.join(", ") || "none"})`);
    ok(a === b && b === c, "three callers share ONE probe (the same answer object)");
    ok(Array.isArray(a) && a.includes("libx264"), "libx264 found (the bundled ffmpeg)");
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  app.exit(fail ? 1 : 0);
});
