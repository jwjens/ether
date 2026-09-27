// smoke-rta.js — SLICE 8: the live RTA's lease and its wiring (docs/dsp-channel-rta.md). The DSP (a sweep lands in
// the right band at −18, the HPF's own curve, GEQ +6 on the master, nothing copied when unsubscribed, trap 0) is
// proven through the real callback in `npm run test:rust` (rta_through_the_mixer); this checks the parts around it.
//
//   node audiod/smoke-rta.js
"use strict";
const fs = require("fs");
const path = require("path");
const { RtaLeases } = require("./rta-lease");
let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  OK   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

console.log("\nSLICE 8 — the RTA lease: the tap follows the view, and stops by itself");
{
  const L = new RtaLeases(5000);
  check(L.subscribe(1, "u1", "S1", 0) === "S1", "a first subscription sets the engine's target");
  check(L.subscribe(1, "u1", "S1", 2000) === null, "a renewal of the same target sends nothing");
  check(L.subscribe(1, "u1", "master", 3000) === "master", "a new target replaces it (one target per station)");
  check(L.expire(7000).length === 0, "renewed within 5 s: still live");
  check(JSON.stringify(L.expire(8001)) === "[1]" && L.get(1) === null, "no renewal for more than 5 s: the lease lapses (the daemon sends \"\" — tap off)");
  check(L.subscribe(1, "u1", "S1", 9000) === "S1", "a view that comes back re-arms it");
  check(L.subscribe(1, "u1", "", 9500) === "" && L.get(1) === null, "a view that says \"\" (unmount) stops it at once");
  check(L.subscribe(2, "u2", "", 0) === null, "\"\" with nothing subscribed sends nothing");
}

console.log("\nthe wiring");
{
  const d = src("audiod/ether-audiod.js");
  check(/rtaSubscribe:/.test(d) && /rtaLeases\.expire\(now\)/.test(d) && /A\.audioSetRta\(sid, ""\)/.test(d), "the daemon holds the lease and clears the engine's target when it lapses");
  check(/broadcast\(\{ event: "rta", stationUuid: l\.uuid/.test(d), "RTA frames go out by station UUID, only for stations with a lease");
  check(!/audioGetSpectrum\(/.test(d) && !/getSpectrum:/.test(d) && !/audioGetSpectrum\(|ipcMain\.handle\("audio:getSpectrum"/.test(src("electron/main.js")) && !/getSpectrum/.test(src("electron/preload.js")), "the old spectrum is retired end to end: no call, no route, no bridge (ruling 4)");
  const m = src("electron/main.js");
  check(/"audio:rta-subscribe"/.test(m) && /sendToAllWindows\("audio:rta", m\)/.test(m), "main routes the subscription and forwards frames");
  const hook = src("src/hooks/useRta.ts");
  check(/setInterval\(renew, 2000\)/.test(hook) && /rtaSubscribe\(stationId, ""\)/.test(hook), "the view renews every 2 s and says \"\" when it goes away");
  const crv = src("src/components/rack/EqCurve.tsx");
  check(/<RtaBars frame=\{rta\.frame\} held=\{rta\.held\} x=\{x\}/.test(crv), "the channel spectrum is RtaBars on the curve's OWN x (the same function, not a copy)");
  check(crv.indexOf("<RtaBars") < crv.indexOf('d={path(running)}') && /pointerEvents="none"/.test(src("src/components/rack/RtaBars.tsx")), "the spectrum is under the curve and takes no pointer events — the curve stays on top");
  check(/NOT FED/.test(crv) && /coarseSpan\(/.test(src("src/components/rack/RtaBars.tsx")), "NOT FED when nothing plays; the coarse bands hatched");
  // Jeff's ruling (2026-09-26): the old master rack's level-coloured bars, glow and peak-hold markers — never one flat colour.
  const bars = src("src/components/rack/RtaBars.tsx");
  check(/fill=\{`url\(#\$\{id\}-lvl\)`\}/.test(bars) && /LEVEL_STOPS\.map/.test(bars) && !/fill="var\(--rta-/.test(bars), "the bars are filled with the LEVEL gradient (green → yellow → amber → red by height) — never one flat colour");
  // Jeff's X32 reference (2026-09-27): ~120 discrete 1/12-octave bars with gaps, blue → green → yellow → red at the top.
  check(/groupBars\(frame\.finePost/.test(bars) && /groupBars\(frame\.finePre/.test(bars) && /const gap = /.test(bars), "the fine wave is grouped into discrete 1/12-octave bars with a small gap (the X32's bars, not a dense wave)");
  check(/stroke="#ffffff"/.test(bars) && /hold &&/.test(bars), "peak hold: a thin white marker per bar");
  check(/opacity=\{0\.32\}/.test(bars) && /<g fill=\{`url\(#\$\{id\}-lvl\)`\}>/.test(bars), "pre-rack the same colours dimmed, post-rack full");
  const axis = src("src/components/rack/scopeAxis.ts");
  check(/FREQ_GRID = \[20, 40, 60, 80, 100, 200, 400, 600, 800, 1000, 2000, 4000, 6000, 8000, 10000, 20000\]/.test(axis) && /DB_GRID = \[15, 10, 5, 0, -5, -10, -15\]/.test(axis), "the X32 grid: frequency lines 20…20k, EQ dB lines −15…+15");
  check(/<RtaGrid /.test(crv) && /stroke=\{CURVE_COLOR\}/.test(crv) && /numbered band markers/.test(crv), "the channel curve: the grid, the EQ curve in X32 yellow on top, numbered band markers");
  const gg = src("src/components/rack/GeqGraph.tsx");
  check(/<RtaGrid /.test(gg) && /<RtaBars /.test(gg) && /geqResponseDb/.test(gg) && /GEQ_FREQS\.map/.test(gg), "the master GEQ graph: the SAME grid and bars, its own curve from the engine's filters, a numbered marker per fader");
  check(/from "\.\/scopeAxis"/.test(crv) && /from "\.\/scopeAxis"/.test(gg), "one shared axis for both graphs");
  check(/autoTop\(/.test(bars) && /BARS_RANGE_DB/.test(bars), "the range follows the running peak like the old analyser's normaliser (60 dB), labelled in real dBFS");
  check(/<GeqGraph /.test(src("src/components/rack/Rack.tsx")), "the master GEQ view draws GeqGraph (RtaBars + RtaGrid, as the channel curve)");
  const view = src("src/components/rack/ChannelRackView.tsx");
  check(/useRta\(curveShown \? slot : null\)/.test(view) && /PEAK HOLD/.test(view), "the channel view listens only while the curve is on screen, with PEAK HOLD");
  const rack = src("src/components/rack/Rack.tsx");
  check(/useRta\("master"\)/.test(rack) && !/getSpectrum/.test(rack), "the master GEQ view reads the RTA, not the retired spectrum");
  check(/localStorage\.getItem\(PEAK_KEY\) !== "0"/.test(hook), "PEAK HOLD (the old rack's markers) is ON unless the viewer turns it off — supersedes ruling 3's default, flagged in the doc");
  check(/finePost/.test(hook) && /fineN/.test(src("native/src/lib.rs")), "the views draw the fine wave (241 points), not the 31 bands");
  const eq = src("native/src/eq.rs");
  check(!/rustfft|update_spectrum|fn spectrum/.test(eq), "eq.rs has no FFT left: the master analyser is off the audio thread entirely");
  check(/Reading the spectrum/.test(src("docs/help-channel-eq.md")) && /before the GEQ/.test(src("docs/help-processor-rack.md")), "help: channel EQ and the processor rack explain the spectrum");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
