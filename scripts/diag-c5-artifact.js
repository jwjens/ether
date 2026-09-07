// COMMITTED ON PURPOSE, and excluded from the installer.
//
// This is not a one-off diagnostic and it does not expire (CLAUDE.md: temporary tooling must be torn
// down). It is a RECEIPT TOOL: the way a claim about a BUILT ARTIFACT gets proved rather than argued.
// Point it at any ether-audio.node - the repo copy, or the one inside dist-electron/win-unpacked - and
// it answers from that binary. It keeps the diag- prefix so electron-builder's existing
// "!**/scripts/diag-*.js" rule keeps it out of the shipped app; .gitignore carries an explicit
// exception for it.
//
// scripts/diag-c5-artifact.js — C5 measured THROUGH the shipped module.
//
// Jeff's condition on the local/stream split: the one-vs-two-instance number must come from the built
// artifact, not from the cargo test harness, which is a separate binary. This calls
// audioBenchProcessor across the NAPI boundary in whichever .node you point it at.
//
//   node scripts/diag-c5-artifact.js <ether-audio.node> [seconds] [runs]
"use strict";
const p = process.argv[2];
const secs = Number(process.argv[3] || 30);
const runs = Number(process.argv[4] || 3);
if (!p) { console.error("usage: node scripts/diag-c5-artifact.js <ether-audio.node> [seconds] [runs]"); process.exit(2); }
const A = require(p);
if (typeof A.audioBenchProcessor !== "function") {
  console.error("this module has no audioBenchProcessor export - it predates the C5 entry point");
  process.exit(2);
}
console.log("module : " + p);
console.log("signal : " + secs + "s per run, " + runs + " runs, 10 ms blocks\n");

const med1 = [], med2 = [], ratios = [];
for (let r = 1; r <= runs; r++) {
  const o = JSON.parse(A.audioBenchProcessor(secs, 4 + r));
  med1.push(o.one.median_ms); med2.push(o.two.median_ms); ratios.push(o.ratio_median);
  console.log(`run ${r}: ONE median ${o.one.median_ms.toFixed(4)} ms (worst ${o.one.worst_ms.toFixed(3)})   ` +
              `TWO median ${o.two.median_ms.toFixed(4)} ms (worst ${o.two.worst_ms.toFixed(3)})   ` +
              `${o.ratio_median.toFixed(2)}x   budget ${o.budget_share_two_pct.toFixed(1)}%`);
}
const mid = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nMEDIAN OF RUNS: one ${mid(med1).toFixed(4)} ms   two ${mid(med2).toFixed(4)} ms   ` +
            `${mid(ratios).toFixed(2)}x   ${(mid(med2) / 10 * 100).toFixed(1)}% of the 10 ms callback budget`);
