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
  check(/rtaPath\(rta\.frame\.pre, x,/.test(crv) && /rtaPath\(rta\.frame\.post, x,/.test(crv), "the channel spectrum is drawn on the curve's OWN x (the same function, not a copy)");
  check(crv.indexOf("rtaPath(rta.frame.pre") < crv.indexOf('d={path(running)}') && /pointerEvents="none"/.test(crv), "the spectrum is under the curve and takes no pointer events — the curve stays on top");
  check(/NOT FED/.test(crv) && /coarseSpan\(/.test(crv), "NOT FED when nothing plays; the coarse bands hatched");
  const view = src("src/components/rack/ChannelRackView.tsx");
  check(/useRta\(curveShown \? slot : null\)/.test(view) && /PEAK HOLD/.test(view), "the channel view listens only while the curve is on screen, with PEAK HOLD");
  const rack = src("src/components/rack/Rack.tsx");
  check(/useRta\("master"\)/.test(rack) && !/getSpectrum/.test(rack), "the master GEQ view reads the RTA, not the retired spectrum");
  check(/localStorage\.getItem\(PEAK_KEY\) === "1"/.test(hook), "PEAK HOLD is off unless the viewer turned it on (ruling 3)");
  const css = src("src/index.css");
  check(["--rta-pre:", "--rta-post:", "--rta-post-line:"].every(t => (css.match(new RegExp(t, "g")) || []).length === 4), "the RTA colours exist in all four themes");
  const eq = src("native/src/eq.rs");
  check(!/rustfft|update_spectrum|fn spectrum/.test(eq), "eq.rs has no FFT left: the master analyser is off the audio thread entirely");
  check(/Reading the spectrum/.test(src("docs/help-channel-eq.md")) && /before\*\* the GEQ/.test(src("docs/help-processor-rack.md")), "help: channel EQ and the processor rack explain the spectrum");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
