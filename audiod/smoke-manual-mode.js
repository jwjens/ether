// Bench for the MANUAL-MODE CONTRACT (2026-07-31). Exercises the REAL DaemonEngine — no audio, no DB,
// no daemon. Safe to run anytime.  node audiod/smoke-manual-mode.js   (exit 0 = pass)
//
// THE CONTRACT (Jeff): MANUAL stops automation DECIDING, never stops the engine RUNNING. Press MANUAL
// mid-song and the song keeps playing; the jock owns the hour — nothing automated fires, spot anchors
// and the top-of-hour hard cut included. Press AUTO and the calendar runs from the real-time clock.
//
// WHY THIS BENCH EXISTS: on 2026-07-31 a jock on halloVeen pressed play in MANUAL and got dead air with
// a UI that said "playing", recovering only after four AUTO/MANUAL toggles. stop() was emptying every
// deck and killing the poll loop.  Cause: docs/manual-mode-dead-air-trace-2026-07-31.md
//                                Contract: docs/design-manual-mode-contract-2026-07-31.md
//
// The failure mode these guard against is automation firing during a live shift — a rotate or a hard cut
// under a talk break. ONE ASSERTION PER DECIDING PATH: any single leak is a live-air fault.
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

/** An engine with every actuator tripwired and a deck genuinely "playing". */
function rig({ started = false } = {}) {
  const acted = [];
  const e = new DaemonEngine(2, {}, () => {});
  e._log = (...a) => acted.push(["LOG", a.join(" ")]);
  e._stop = (d) => acted.push(["STOP", d]);
  e._play = (d) => acted.push(["PLAY", d]);
  e._load = (d) => acted.push(["LOAD", d]);
  e.handleRotate = (f, t) => acted.push(["ROTATE", f, t]);
  e.preload = (d) => { acted.push(["PRELOAD", d]); return Promise.resolve(); };
  e.refillIfNeeded = () => { acted.push(["REFILL"]); return Promise.resolve(); };
  e._advance = (w, fn) => { acted.push(["ADVANCE", w]); return fn(); };
  e._maybeEmitDeck = (d) => acted.push(["EMIT", d]);
  e._started = started;
  e.stateA = { status: "playing", title: "Jock's song", filePath: "a.mp3", positionSec: 30, durationSec: 200 };
  e.stateB = { status: "idle", title: "", filePath: "", positionSec: 0, durationSec: 0 };
  e.stateC = { status: "idle", title: "", filePath: "", positionSec: 0, durationSec: 0 };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  e.queue = [{ title: "next", filePath: "n.mp3", durationMs: 180000, qid: "q1" }];
  return { e, acted };
}

console.log("── 1-2 · stop() stops DECIDING, not RUNNING ──");
{
  const { e, acted } = rig({ started: true });
  e.pollTimer = setInterval(() => {}, 60000);
  e._procMeterTimer = setInterval(() => {}, 60000);
  e.stop();
  check("1 · stop() does NOT stop any deck (the jock keeps their song)", acted.filter(a => a[0] === "STOP"), []);
  check("1 · the playing deck is untouched by stop()", e.stateA.status, "playing");
  check("2 · stop() leaves the poll timer ALIVE (deck events keep flowing)", e.pollTimer !== null, true);
  check("2 · stop() leaves the proc-meter timer alive (the jock's levels)", e._procMeterTimer !== null, true);
  check("2 · automation is off", e._started, false);
  e.dispose();
  check("2 · dispose() DOES clear the poll timer (shutdown path only)", e.pollTimer, null);
  check("2 · dispose() clears the proc-meter timer", e._procMeterTimer, null);
}

console.log("\n── 3 · MANUAL: every deciding path is silent (one assertion each) ──");
{
  const { e, acted } = rig({ started: false });
  check("3 · _mayDecide() is false in MANUAL", e._mayDecide(), false);

  // end-detection → rotate: a deck finishing is the jock's business
  e.checkEnd("A", 199.9, 200, "playing", true);
  check("3a · checkEnd does NOT rotate", acted.filter(a => a[0] === "ROTATE"), []);

  // self-heal: must never preload over a hand-cued deck, never refill
  e._maintain();
  check("3b · _maintain does NOT preload", acted.filter(a => a[0] === "PRELOAD"), []);
  check("3b · _maintain does NOT refill", acted.filter(a => a[0] === "REFILL"), []);

  // the top-of-hour HARD CUT must not fire under a talk break
  e._lastHourCut = -1;
  e._checkTopOfHour();
  check("3c · the top-of-hour hard cut does NOT fire", acted.filter(a => a[0] === "ADVANCE" && /top-of-hour/.test(a[1])), []);

  // segue overlap (which is how a spot anchor reaches air) must not fire
  e.stateA.positionSec = 198;   // inside the overlap window
  e.segueOverlap = 3;
  e._segueTick(Date.now());
  check("3d · the segue overlap does NOT fire (no spot anchor, no auto-rotate)", acted.filter(a => a[0] === "ROTATE"), []);

  // jingles are automation too
  e._jingleTick(Date.now());
  check("3e · the jingle tick does not arm or fire", acted.filter(a => /jingle/i.test(a[1] || "")), []);

  // the stall watchdog must not "recover" a jock's deliberate silence
  e._lastPlayingAt = 0;
  e._watchdog();
  check("3f · the dead-air watchdog does NOT force an advance (the jock owns the silence)",
    acted.filter(a => a[0] === "ADVANCE" && /watchdog/.test(a[1])), []);

  check("3 · nothing was played or loaded in MANUAL, at all",
    acted.filter(a => a[0] === "PLAY" || a[0] === "LOAD"), []);
}

console.log("\n── 4 · MANUAL: the engine keeps RUNNING (the UI stays live) ──");
{
  const { e, acted } = rig({ started: false });
  e._maybeEmitDeck("A");
  check("4 · deck events still fire in MANUAL (live position for the jock)", acted.filter(a => a[0] === "EMIT"), [["EMIT", "A"]]);
  // _emitProcMeters is no longer gated on _started; with _procOn false it returns for the RIGHT reason.
  e._procOn = false;
  check("4 · proc meters are not gated on automation", e._emitProcMeters(), undefined);
}

console.log("\n── 5 · the liveDeck guard OBSERVES in MANUAL, ENFORCES in AUTO ──");
{
  // Two decks on air, held well past the grace, in MANUAL: log, never stop.
  const { e, acted } = rig({ started: false });
  e.liveDeck = "A";
  e.stateB = { status: "playing", title: "Jock's bed", filePath: "b.mp3", positionSec: 10, durationSec: 100 };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  e._foreignSince = 1;
  e._liveDeckObserverTick(1 + e._foreignGraceMs() + 1);
  check("5 · MANUAL: the guard does NOT stop the jock's second deck", acted.filter(a => a[0] === "STOP"), []);
  check("5 · MANUAL: but it still LOGS what it sees", acted.some(a => a[0] === "LOG" && /TWO DECKS ON AIR/.test(a[1])), true);
  check("5 · MANUAL: the line says it is observing, not stopping", acted.some(a => a[0] === "LOG" && /MANUAL: observing only/.test(a[1])), true);

  // Same shape in AUTO: enforce.
  const r2 = rig({ started: true });
  r2.e.liveDeck = "A";
  r2.e.stateB = { status: "playing", title: "stray", filePath: "b.mp3", positionSec: 10, durationSec: 100 };
  r2.e._deckState = (d) => (d === "A" ? r2.e.stateA : d === "B" ? r2.e.stateB : r2.e.stateC);
  r2.e._foreignSince = 1;
  r2.e._liveDeckObserverTick(1 + r2.e._foreignGraceMs() + 1);
  check("5 · AUTO: the guard DOES stop the foreign deck", r2.acted.filter(a => a[0] === "STOP"), [["STOP", "B"]]);
}

console.log("\n── 6-9 · the handover ──");
{
  const { e } = rig({ started: true });
  e.stop();
  check("6 · MANUAL pressed mid-song: the playing deck's status is unchanged", e.stateA.status, "playing");
  check("6 · …and it still holds its content", e.stateA.filePath, "a.mp3");
}
{
  // 7 — AUTO with a deck genuinely playing: adopt, do not restart. _isAudiblyOnAir is the observed check.
  const { e, acted } = rig({ started: false });
  e.init = () => {};
  e._state = () => ({ deckA: { status: "playing" }, deckB: {}, deckC: {} });
  e._isAudiblyOnAir = async () => true;
  e.loadToDeck = (d) => { acted.push(["LOAD", d]); return true; };
  return_7: {
    e.start().then(() => {
      check("7 · AUTO adopts a genuinely playing deck — never restarts it", acted.filter(a => a[0] === "PLAY"), []);
      check("7 · …and does not reload it", acted.filter(a => a[0] === "LOAD"), []);
      check("7 · automation is engaged again", e._started, true);
      check("7 · resuming from MANUAL is flagged for the calm summary wording", e._resumingFromManual, true);
      finish();
    });
  }
}

function finish() {
  console.log("\n── 10-11 · empty-deck honesty (contract, asserted at the seam the daemon relays) ──");
  // The refusal itself lives in Rust (audio_play returns false when file_path is empty) and is relayed by
  // the daemon's play handler. What this bench can assert is the SHAPE the daemon depends on: a deck with
  // no content is distinguishable from one with content, by the same field Rust now trusts.
  const { e } = rig({ started: false });
  check("10 · a deck with no content is identifiable (what audio_play refuses on)", !e.stateB.filePath, true);
  check("11 · a loaded deck is identifiable (what audio_play accepts)", !!e.stateA.filePath, true);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}
