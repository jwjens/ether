// Bench — the two rough edges (2026-08-03). Source-contract: both live in renderer code that binds
// window.ether and React, so the behavioural gate is Jeff's launch. This guards the structure.
//   node scripts/smoke-monitor-and-flicker.js
"use strict";
const fs = require("fs"), path = require("path");
const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const app = R("src", "App.tsx"), eng = R("src", "audio", "engine-rodio.ts"), mix = R("src", "components", "StationMonitorMixer.tsx");
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };
const NL = String.fromCharCode(10);

// 2026-10-12 (docs/station-monitor-zeroed-at-attach-2026-10-12.md): the D2 attach-time assert is GONE. It zeroed the station
// MONITOR half a second after the engine restored it (Jeff: "the halloween fader was up i had to nudge it for audio to
// play"). The engine's restored board is the truth; the window sends the operator's change and nothing else.
console.log("── 1 · MONITOR: the window never writes the station MONITOR on attach ──");
check("1 · no attach-time monitor assert", !eng.includes("assertMonitorSilence") && !eng.includes("monitor asserted to"));
check("1 · no attach-time MASTER re-assert", !eng.includes("reassertMaster") && !eng.includes("operatorMasterLevel"));
check("1 · no cached operator monitor level", !(eng + mix).includes("noteOperatorMonitor"));
check("1 · the strip still sends the operator's change, then saves it",
  mix.indexOf("setMonitorVolume?.(sid, value)") > 0 && mix.indexOf("setMonitorVolume?.(sid, value)") < mix.indexOf('"monitor_volume", String(value)'));

console.log(NL + "── 2 · the segue overlap is not re-pushed on attach ──");
check("2 · no pushSegueOverlap", !eng.includes("pushSegueOverlap"));

console.log(NL + "── 3 · AUTO FLICKER: a press is held until the daemon confirms ──");
check("3 · an in-flight command ref exists", app.includes("const autoCmdRef = useRef<{ value: boolean; until: number } | null>(null);"));
check("3 · ENGAGE arms it", app.includes("autoCmdRef.current = { value: true, until: Date.now() + 4000 };"));
check("3 · STOP arms it", app.includes("autoCmdRef.current = { value: false, until: Date.now() + 4000 };"));
check("3 · the poll HOLDS the pressed value while in flight", app.includes("else if (Date.now() < cmd.until) { setAutoAdv(cmd.value); return; }"));
check("3 · confirmation RELEASES the hold (observation resumes)", app.includes("if (obs === cmd.value) autoCmdRef.current = null;"));
check("3 · a timed-out command releases too — observation must win if the command failed",
  app.includes("else autoCmdRef.current = null;"));
check("3 · the station-switch effect cannot clobber a press in flight",
  app.includes("setAutoAdv(autoCmdRef.current ? autoCmdRef.current.value : (read ?? null));"));

console.log(NL + "── 4 · the traces stay in until Jeff confirms both ──");
["ENGINESTATE-IN", "OBSERVED-AUTO", "SWITCH-EFFECT"].forEach(t =>
  check(`4 · ${t} retained`, (app + eng).includes(t)));

console.log(`${NL}${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
