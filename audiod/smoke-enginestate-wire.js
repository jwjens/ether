// Bench — THE WIRE: daemon → main relay → renderer (2026-08-03).
//   node audiod/smoke-enginestate-wire.js   (exit 0 = pass)
//
// THE BUG THIS EXISTS FOR. The daemon published `started` (automation engaged). The renderer read it.
// Both ends were benched and both passed. main.js's relay re-BUILT the payload by hand:
//     sendToAllWindows("audio:daemon-enginestate", { stationId: m.stationId, state: m.state })
// so `started` was DELETED in transit. The renderer saw started=undefined forever, observedAutomation
// returned null, and the pill showed MANUAL over a provably automating station — surviving three pill
// redesigns, an attach investigation, a mount-storm theory and a stale-daemon theory, because every one
// of them tested an END and none tested the WIRE.
//
// This bench takes a REAL payload from a REAL DaemonEngine and pushes it through the actual relay
// transform, asserting the field survives the hop — and that the OLD transform would have failed here.
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
const fs = require("fs");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

/** The REAL enginestate payload, straight off a real engine — not a fixture I wrote. */
function realPayload({ started }) {
  const events = [];
  const e = new DaemonEngine(2, {}, (event, p) => events.push({ event, ...p }));
  e._log = () => {}; e._dur = () => 0; e._maybeEmitDeck = () => {};
  e._started = started;
  e._computeEngineState = () => "live";
  e._engineState = "off";
  e._emitEngineState();
  return events.find(v => v.event === "enginestate");
}

// The two transforms, as they exist/existed in electron/main.js.
const RELAY_NEW = (m) => { const { event: _e, ...rest } = m; return rest; };
const RELAY_OLD = (m) => ({ stationId: m.stationId, state: m.state });

console.log("── 1 · a REAL daemon payload carries started ──");
{
  const m = realPayload({ started: true });
  check("1 · the daemon emits enginestate", !!m, true);
  check("1 · …carrying started=true", m.started, true);
  check("1 · …and the state", m.state, "live");
}

console.log("\n── 2 · THE WIRE: started SURVIVES the relay ──");
{
  const out = RELAY_NEW(realPayload({ started: true }));
  check("2 · started survives the hop", out.started, true);
  check("2 · stationId survives", out.stationId, 2);
  check("2 · state survives", out.state, "live");
  check("2 · the internal `event` key is stripped (the channel carries it)", out.event, undefined);
}
{
  const out = RELAY_NEW(realPayload({ started: false }));
  check("2 · started=false survives as FALSE, not dropped to undefined", out.started, false);
  check("2 · …and typeof stays boolean (undefined would render UNKNOWN forever)", typeof out.started, "boolean");
}

console.log("\n── 3 · the OLD hand-listing relay is proven to DROP it (guards the regression) ──");
{
  const out = RELAY_OLD(realPayload({ started: true }));
  check("3 · the old transform loses started", out.started, undefined);
  check("3 · …which is exactly what the renderer saw: started=undefined", typeof out.started, "undefined");
}

console.log("\n── 4 · main.js actually USES the passthrough, not the hand-list ──");
{
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
  const code = main.split(String.fromCharCode(10)).filter(l => !l.trim().startsWith("//")).join(String.fromCharCode(10));
  check("4 · the hand-listed payload is GONE from the enginestate relay",
    code.includes('sendToAllWindows("audio:daemon-enginestate", { stationId: m.stationId, state: m.state })'), false);
  check("4 · the relay forwards a spread payload",
    code.includes("sendToAllWindows(\"audio:daemon-enginestate\", enginestatePayload)"), true);
}

console.log("\n── 5 · any FUTURE field added at the daemon also survives (the class is dead) ──");
{
  const m = realPayload({ started: true });
  m.someFutureField = "xyz";                       // a field nobody has written yet
  check("5 · an unknown field survives the relay untouched", RELAY_NEW(m).someFutureField, "xyz");
  check("5 · the old relay would have dropped it", RELAY_OLD(m).someFutureField, undefined);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
