// Bench for the AUTO-FITTER (§2.7, v1 observation-only). Exercises the REAL audiod/autofit.js.
// NO audio, NO DB, NO daemon — safe to run anytime.
//   node audiod/smoke-autofit.js     (exit 0 = pass)
//
// The first two groups are TODAY'S LIVE CASES, encoded from measured log timestamps — if the fitter
// cannot answer these it is not worth shipping.
// Design of record: docs/design-auto-fitter-2026-07-30.md
"use strict";
const path = require("path");
const { computeFit, describeFit, windowRows, FIT_TOLERANCE_SEC, LOOKAHEAD_SEC } = require(path.join(__dirname, "autofit.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const T = (h, m, s = 0) => Math.floor(new Date(2026, 6, 30, h, m, s).getTime() / 1000);
const song = (title, secs) => ({ title, contentClass: "MUSIC", durationMs: secs * 1000, filePath: `${title}.mp3` });
const spot = (title, secs) => ({ title, contentClass: "SPOT", durationMs: secs * 1000, filePath: `${title}.mp3` });
// Station 4's real pool, from today's decoded durations.
const S4_POOL = [18,73,98,109,115,123,124,126,127,128,129,131,132,133,137,141,156,163,164,173,179,180,190,191,192,206,211,213,225,240,241,310]
  .map(d => song(`pool${d}`, d));

console.log("── CASE B — the live 2026-07-30 miss on station 4 ──");
// Seam 19:58:02, anchor 20:00:00 (the 13:00 hard cut), a 211s row cued into a 118s window.
{
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("WhatTheWorldNeedsNow", 211)], S4_POOL);
  check("Case B: overshoot detected", fit.mode, "swap");
  check("Case B: the gap is the 93s that got chopped", Math.round(fit.gapSec), 93);
  check("Case B: swaps the 211s row", fit.action.from.title, "WhatTheWorldNeedsNow");
  // need = 211 − 93 = 118s. The pool has no 118: 115 (|Δ|=3) is nearer than 123 (|Δ|=5), so 115 is correct.
  check("Case B: picks the nearest available size to the 118s hole", Math.round(fit.action.to.durationMs / 1000), 115);
  check("Case B: new arrival is within tolerance", Math.abs(fit.action.newGapSec) <= FIT_TOLERANCE_SEC, true);
}

console.log("\n── CASE A — the 13:00 hard cut, all four stations ──");
// Measured: seam = when the song went LIVE, anchor = 20:00:00, duration = the song that was chopped.
const CASE_A = [
  { st: "s1", seam: T(19, 59, 46), dur: 240, pool: [13, 14, 15, 30, 60, 120] },
  { st: "s2", seam: T(19, 59, 30), dur: 250, pool: [28, 30, 32, 90, 150] },
  { st: "s3", seam: T(19, 58, 41), dur: 200, pool: [76, 78, 80, 120, 160] },
  { st: "s4", seam: T(19, 58, 2), dur: 211, pool: [115, 118, 123, 124] },
];
for (const c of CASE_A) {
  const pool = c.pool.map(d => song(`p${d}`, d));
  const fit = computeFit(c.seam, T(20, 0, 0), [song("TheChoppedSong", c.dur)], pool);
  check(`${c.st}: a fit is found (nothing would have been chopped)`, fit.mode, "swap");
  check(`${c.st}: arrival lands within ±${FIT_TOLERANCE_SEC}s of 13:00`, Math.abs(fit.action.newGapSec) <= FIT_TOLERANCE_SEC, true);
}

console.log("\n── UNDERSHOOT ──");
{
  // Arrive 47s early: 120s of music into a 167s window.
  const fit = computeFit(T(12, 0, 0), T(12, 2, 47), [song("Short", 120)], [song("Fill45", 45), song("Fill47", 47), song("Fill200", 200)]);
  check("undershoot: inserts one fill", fit.mode, "insert");
  check("undershoot: picks the closest fill", fit.action.fill.title, "Fill47");
  check("undershoot: arrival within tolerance", Math.abs(fit.action.newGapSec) <= FIT_TOLERANCE_SEC, true);
}
{
  // Tie between a slightly-short and a slightly-long fill → prefer the LONGER (a small overshoot beats a hole).
  const fit = computeFit(T(12, 0, 0), T(12, 2, 47), [song("Short", 120)], [song("Fill45", 45), song("Fill49", 49)]);
  check("undershoot tie: prefers the longer fill over leaving a hole", fit.action.fill.title, "Fill49");
}
{
  const fit = computeFit(T(12, 0, 0), T(12, 2, 47), [song("Short", 120)], [song("WayTooLong", 600)]);
  check("undershoot: no fill within tolerance → no-fit, not a bad insert", fit.mode, "no-fit");
}

console.log("\n── SEPARATION-BLOCKED (the caller pre-filters; the fitter must respect the filtered pool) ──");
{
  // The perfect-size song is NOT in candidates because separation excluded it.
  const eligible = [song("Ok120", 120), song("Ok200", 200)];
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("Long", 211)], eligible);
  check("blocked: never picks outside the eligible pool", ["Ok120", "Ok200"].includes(fit.action ? fit.action.to.title : ""), true);
  check("blocked: still lands within tolerance using what IS eligible", Math.abs(fit.action.newGapSec) <= FIT_TOLERANCE_SEC, true);
}
{
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("Long", 211)], [song("OnlyBadSize", 300)]);
  check("blocked: nothing eligible fits → no-fit, never a violation", fit.mode, "no-fit");
}

console.log("\n── THIN POOL / NO FIT — states it, changes nothing, does not thrash ──");
{
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("Long", 211)], []);
  check("empty pool → no-fit", fit.mode, "no-fit");
  check("no-fit carries no action", fit.action, null);
  check("no-fit names the gap and the pool size", /overshoot \+93s — no single swap fits \(0 eligible\)/.test(fit.reason), true);
  check("no-fit line says the hard cut will trim", /hard cut will trim/.test(describeFit(fit, T(20, 0, 0), true)), true);
}

console.log("\n── SINGLE-SWAP ONLY (v1) ──");
{
  // Two rows where NO single swap can close the gap, but a two-row swap could. v1 must report no-fit.
  const pending = [song("A", 200), song("B", 200)];
  const fit = computeFit(T(12, 0, 0), T(12, 5, 0), pending, [song("C", 195), song("D", 195)]);
  check("v1: a window needing two swaps is a logged no-fit", fit.mode, "no-fit");
}

console.log("\n── IDEMPOTENCE ──");
{
  const pending = [song("Fits", 118)];
  const a = computeFit(T(19, 58, 2), T(20, 0, 0), pending, S4_POOL);
  const b = computeFit(T(19, 58, 2), T(20, 0, 0), pending, S4_POOL);
  check("an already-fitted window reports fitted", a.mode, "fitted");
  check("fitted carries no action", a.action, null);
  check("re-running is identical (no churn)", JSON.stringify(a), JSON.stringify(b));
  check("fitted produces NO log line", describeFit(a, T(20, 0, 0), true), null);
}

console.log("\n── NEVER-TOUCH INVARIANTS ──");
{
  // A SPOT row inside the window must never be the swap target.
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [spot("TheSpot", 18), song("Long", 211)], S4_POOL);
  check("a SPOT row is never swapped", fit.action ? fit.action.from.title : "", "Long");
}
{
  // A spot-only window leaves ~100s of dead time before the anchor. Filling that IS the fitter's job —
  // what must never happen is the SPOT itself being swapped or dropped.
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [spot("TheSpot", 18)], S4_POOL);
  check("a spot-only window is filled, never swapped", fit.mode, "insert");
  check("…and the SPOT itself is untouched", fit.action.type, "insert");
}
{
  // JIN/SWP overlays are not deck tracks and are never swap targets either.
  const jin = { title: "Sweeper", contentClass: "SWP", durationMs: 8000, filePath: "s.mp3" };
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [jin, song("Long", 211)], S4_POOL);
  check("a SWP overlay is never swapped", fit.action ? fit.action.from.title : "", "Long");
}
{
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("Long", 211)], S4_POOL);
  check("the anchor itself is never moved (newArrival is measured AGAINST it)",
    Math.abs(fit.action.newArrivalTs - T(20, 0, 0)) === Math.abs(fit.action.newGapSec), true);
}

console.log("\n── BOUNDARIES ──");
{
  check("anchor exactly at the look-ahead edge → in window",
    computeFit(T(12, 0, 0), T(12, 0, 0) + LOOKAHEAD_SEC, [song("X", 1000)], S4_POOL).mode !== "out-of-window", true);
  check("anchor one second beyond → out of window",
    computeFit(T(12, 0, 0), T(12, 0, 0) + LOOKAHEAD_SEC + 1, [song("X", 1000)], S4_POOL).mode, "out-of-window");
  check("gap exactly at tolerance → fitted, no action",
    computeFit(T(12, 0, 0), T(12, 2, 0) - FIT_TOLERANCE_SEC, [song("X", 120)], S4_POOL).mode, "fitted");
  check("gap one second past tolerance → acted on",
    computeFit(T(12, 0, 0), T(12, 2, 0) - FIT_TOLERANCE_SEC - 1, [song("X", 120)], S4_POOL).mode !== "fitted", true);
  check("no pending rows → no-rows", computeFit(T(12, 0, 0), T(12, 5, 0), [], S4_POOL).mode, "no-rows");
  check("anchor already passed → out-of-window", computeFit(T(12, 5, 0), T(12, 0, 0), [song("X", 120)], S4_POOL).mode, "out-of-window");
  check("no anchor → out-of-window", computeFit(T(12, 0, 0), NaN, [song("X", 120)], S4_POOL).mode, "out-of-window");
  check("windowRows stops at the anchor",
    windowRows(T(12, 0, 0), T(12, 2, 0), [song("A", 60), song("B", 60), song("C", 60)]).rows.length, 2);
}

console.log("\n── THE DECISION LINE ──");
{
  const fit = computeFit(T(19, 58, 2), T(20, 0, 0), [song("WhatTheWorldNeedsNow", 211)], S4_POOL);
  const line = describeFit(fit, T(20, 0, 0), true);
  check("observation wording says 'would have'", /would have swapped/.test(line), true);
  check("names both songs and both durations", /"WhatTheWorldNeedsNow" \(211s\) → ".+" \(\d+s\)/.test(line), true);
  check("states the resulting arrival and gap", /arrival \d\d:\d\d:\d\d \([+-]\d+s\)/.test(line), true);
  check("authoring wording drops 'would have'", /— swapped /.test(describeFit(fit, T(20, 0, 0), false)), true);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
