// smoke-dynamics.js — SLICE 6: the channel dynamics UI is wired to what the engine does (docs/dsp-channel-dynamics.md).
// Static checks (no audio, no device). The DSP itself is proven in `npm run test:rust` (dynamics_through_the_mixer,
// chdsp dynamics tests); the transfer-graph maths in vitest (dynMath.test.ts).
//
//   node audiod/smoke-dynamics.js
"use strict";
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  OK   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

console.log("\nSLICE 6 — gate + compressor, wired from the engine to the board");
const cr = src("src/components/rack/channelRack.ts");
check(/CHANNEL_MODULE_TYPES: ChannelModuleType\[\] = \["filters", "gate", "peq", "comp"\]/.test(cr), "Add offers Filters, Gate, PEQ, Comp in the spec's order (never a ride)");
check(/name: "Off", builtIn: true, doc: \{ v: 1, sections: \{ ch: \[\] \} \}/.test(cr), "the Off preset is the EMPTY rack (ruling 6)");
check(/name: "Voice"/.test(cr) && /threshold: -45, ratio: 4, depth: 15/.test(cr) && /threshold: -20, ratio: 3, attack: 10, release: 150/.test(cr), "the Voice preset carries the ruled values");
const view = src("src/components/rack/ChannelRackView.tsx");
check(/<DynCurve /.test(view) && /chDyn/.test(view), "the rack view draws the transfer graph and reads the engine's GR (chDyn)");
check(/rack_ch_presets/.test(view), "channel presets are stored per station (rack_ch_presets), like the master's");
const curve = src("src/components/rack/DynCurve.tsx");
check(/chainOutDb/.test(curve) && /var\(--dyn-curve\)/.test(curve), "the orange resulting curve is dynMath's chain (the engine's curves)");
const strip = src("src/components/ConsoleStrip.tsx");
check(/chDyn\?\.\[slotIndex\]\?\.\[1\]/.test(strip) && /COMP −/.test(strip), "the fader strip's COMP lamp reads the engine's comp GR (ruling 7)");
const css = src("src/index.css");
check((css.match(/--dyn-curve:/g) || []).length === 4, "--dyn-curve is defined in all four themes");
const daemon = src("audiod/ether-audiod.js");
check(/chDyn: mt\.chDyn/.test(daemon), "the daemon forwards chDyn");
check(fs.existsSync(path.join(__dirname, "..", "docs", "help-channel-dynamics.md")), "docs/help-channel-dynamics.md exists");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
