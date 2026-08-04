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

console.log("── 1 · MONITOR: the fader tells the engine the operator owns the level ──");
check("1 · setMonitor calls noteOperatorMonitor", mix.includes("getEngine(sid).noteOperatorMonitor(value)"));
check("1 · …before pushing the gain (so a re-attach can restore it)",
  mix.indexOf("noteOperatorMonitor") < mix.indexOf("setMonitorVolume?.(sid, value)"));
check("1 · noteOperatorMonitor now HAS a caller (it had zero)",
  (mix + app).includes("noteOperatorMonitor"));

console.log(NL + "── 2 · MONITOR: re-attach restores, never re-mutes ──");
check("2 · a first-attach flag exists", eng.includes("private monitorAssertedOnce = false;"));
check("2 · re-attach with no operator level leaves the bus alone",
  eng.includes("if (this.monitorAssertedOnce && !this.monitorRaisedByOperator) {"));
check("2 · …and says so in the log rather than silently returning",
  eng.includes("already silent, leaving it alone"));
check("2 · a RAISED monitor still re-applies on re-attach (daemon respawn resets the bus to 1.0)",
  eng.includes("const level = this.monitorRaisedByOperator ? this.operatorMonitorLevel : 0;"));

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
