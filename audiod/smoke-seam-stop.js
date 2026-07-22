// Bench for the Bug-A deck-stop guard (2026-07-22 OF two-decks incident fix). Exercises the REAL
// DaemonEngine._outgoingStopAction — the deferred post-crossfade stop decision — with NO audio/DB/pipe,
// so it is safe to run anytime. The invariant: a delayed stop can NEVER leak a decoding deck.
// Run:  node audiod/smoke-seam-stop.js   (exit 0 = pass)
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

console.log("── deck-stop guard (real DaemonEngine._outgoingStopAction; no audio/DB) ──");
const e = new DaemonEngine(99, {}, () => {});
e.deckGen = { A: 5, B: 2, C: 0 };

// 1) THE LEAK CASE: outgoing deck A, same source since the rotate (deckGen 5==5), NOT the incoming (toId=B),
//    and still reports "playing" past the crossfade grace → MUST return 'stop' (force). The old code
//    returned early on status==="playing" and leaked the decoding deck (the two-decks overlap).
e._deckState = () => ({ status: "playing" });
check("leak case: outgoing still playing, same source, not target → force STOP", e._outgoingStopAction("A", 5, "B"), "stop");

// 2) a FRESH source was loaded onto A since the rotate (deckGen bumped 5→ was 4) → never wipe it.
check("reloaded since rotate (deckGen changed) → skip-reloaded", e._outgoingStopAction("A", 4, "B"), "skip-reloaded");

// 3) fromId IS the deck we rotated INTO → never stop the incoming/live deck.
check("is the incoming deck (fromId===toId) → skip-target", e._outgoingStopAction("A", 5, "A"), "skip-target");

// 4) normal segue: the outgoing deck already ended, same source → stop (cleanup).
e._deckState = () => ({ status: "ended" });
check("normal: outgoing ended, same source → stop", e._outgoingStopAction("A", 5, "B"), "stop");

// 5) REGRESSION INTENT: the decision must NOT depend on the outgoing deck's play status (that dependency
//    was the leak escape). Same inputs, "playing" vs "ended" → identical 'stop'.
e._deckState = () => ({ status: "playing" }); const whilePlaying = e._outgoingStopAction("A", 5, "B");
e._deckState = () => ({ status: "ended" });   const whileEnded   = e._outgoingStopAction("A", 5, "B");
check("decision independent of outgoing play-status (no 'playing' escape)", whilePlaying === "stop" && whileEnded === "stop", true);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
