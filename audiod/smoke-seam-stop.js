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

// ── liveDeck OBSERVER (2026-07-29, observation-only) ──────────────────────────────────────────────
// Covers DaemonEngine._foreignPlayingDecks + _foreignGraceMs + _liveDeckObserverTick. The invariant
// under test is the SCOPE of the feature as much as its logic: it must REPORT and never act.
console.log("\n── liveDeck observer (real DaemonEngine._foreignPlayingDecks / _liveDeckObserverTick) ──");
const o = new DaemonEngine(99, {}, () => {});

// 6) healthy: only the deck the engine put on air is playing → nothing foreign.
check("healthy: only liveDeck playing → no foreign decks",
  o._foreignPlayingDecks("A", { A: "playing", B: "paused", C: "ended" }), []);

// 7) THE 2026-07-29 CASE: engine put C on air; A started outside the chain and is also playing.
//    Alphabetical P would answer "A" and orphan C — the observer must name A as the foreign deck.
check("double-play: live=C, A started outside the chain → A is foreign",
  o._foreignPlayingDecks("C", { A: "playing", B: "paused", C: "playing" }), ["A"]);
check("  …and alphabetical P disagrees with liveDeck (this is the defect being observed)",
  ["A", "B", "C"].find(d => ({ A: "playing", B: "paused", C: "playing" })[d] === "playing") !== "C", true);

// 8) both other decks foreign — reported together, in deck order.
check("two foreign decks → both reported",
  o._foreignPlayingDecks("B", { A: "playing", B: "playing", C: "playing" }), ["A", "C"]);

// 9) liveDeck unknown (fresh engine, nothing rotated yet) → never report what we cannot attribute.
check("liveDeck unknown → no anomaly claimed", o._foreignPlayingDecks(null, { A: "playing", B: "playing", C: "ended" }), []);

// 10) a legitimate segue overlap must NOT be reportable: the grace exceeds the window in which the
//     outgoing deck is normally still playing (deferred stop lands at crossfadeDuration + 500ms).
check("grace outlasts a normal segue overlap (cf 3s + 500ms)", o._foreignGraceMs() > o.crossfadeDuration * 1000 + 500, true);
o.segueOverlap = 6; o.crossfadeDuration = 5;
check("grace is DERIVED from the settings, not hardcoded", o._foreignGraceMs(), (6 + 5) * 1000 + 1500);
o.segueOverlap = 3; o.crossfadeDuration = 3;

// 11) _play records the deck the engine put on air — for MUSIC decks only. CART (the jingle overlay)
//     is not a rotation deck and must never become liveDeck. Tested through the real predicate _play
//     uses, so the bench stays free of the audio addon (no engine, no port, safe to run anytime).
check("A/B/C are rotation decks", ["A", "B", "C"].map(d => o._isRotationDeck(d)), [true, true, true]);
check("CART is NOT a rotation deck → can never become liveDeck", o._isRotationDeck("CART"), false);

// 12) ENFORCEMENT (2026-07-30). The tick must STOP a foreign rotation deck past the grace, and must
//     still never play/load/rotate. Wire every actuator to a tripwire and drive the exact live shape.
//     _advance is stubbed to run its closure inline so the bench sees the stop without a real chain.
const acted = [];
const obs = new DaemonEngine(99, {}, () => {});
obs._log = (...a) => acted.push(["LOG", a.join(" ")]);
obs._stop = (d) => acted.push(["STOP", d]);
obs._play = (d) => acted.push(["PLAY", d]);
obs._load = (d) => acted.push(["LOAD", d]);
obs.handleRotate = (f, t) => acted.push(["ROTATE", f, t]);
obs._advance = (where, fn) => { acted.push(["ADVANCE", where]); return fn(); };
obs.liveDeck = "C";
obs.stateA = { status: "playing", title: "Foreign", positionSec: 12, durationSec: 136.8 };
obs.stateB = { status: "paused", title: "", positionSec: 0, durationSec: 0 };
obs.stateC = { status: "playing", title: "Kana Kaloka", positionSec: 21, durationSec: 162.8 };
obs._deckState = (d) => (d === "A" ? obs.stateA : d === "B" ? obs.stateB : obs.stateC);

const t0 = 1_000_000;

// 12a) LEGITIMATE SEGUE OVERLAP — inside the grace, the outgoing deck must be left completely alone.
obs._liveDeckObserverTick(t0);
check("inside grace: nothing logged (a normal overlap is not an anomaly)", acted.length, 0);
check("inside grace: the overlapping deck is NOT stopped", acted.some(a => a[0] === "STOP"), false);
// Hold it across the whole window a real overlap occupies (deferred stop lands at cf+500ms = 3500ms).
obs._liveDeckObserverTick(t0 + 3500);
check("at the deferred-stop moment (cf+500ms): still untouched", acted.length, 0);
obs._liveDeckObserverTick(t0 + obs._foreignGraceMs() - 1);
check("one tick before the grace expires: still untouched", acted.length, 0);

// 12b) PAST GRACE — report AND stop.
obs._liveDeckObserverTick(t0 + obs._foreignGraceMs() + 1);
check("past grace: exactly one anomaly line", acted.filter(a => a[0] === "LOG").length, 1);
check("the line names both decks and both titles",
  /TWO DECKS ON AIR.*station 99.*C="Kana Kaloka".*FOREIGN A="Foreign"/.test(acted[0][1]), true);
check("the line states the stop", /STOPPING A/.test(acted[0][1]), true);
check("the stop ran ON THE ADVANCE CHAIN", acted.some(a => a[0] === "ADVANCE" && a[1] === "liveDeck-guard"), true);
check("the FOREIGN deck was stopped", acted.filter(a => a[0] === "STOP").map(a => a[1]), ["A"]);
check("the LIVE deck was never stopped", acted.some(a => a[0] === "STOP" && a[1] === "C"), false);
check("deckReady cleared for the stopped deck", obs.deckReady.has("A"), false);

// 12c) STILL NOT AN ACTUATOR for anything else — it may stop, never start.
check("guard never plays a deck", acted.some(a => a[0] === "PLAY"), false);
check("guard never loads a deck", acted.some(a => a[0] === "LOAD"), false);
check("guard never issues a rotate", acted.some(a => a[0] === "ROTATE"), false);

// 12d) Re-log throttle while the condition persists (a stop that cannot land must not spam).
obs._liveDeckObserverTick(t0 + obs._foreignGraceMs() + 2000);
check("re-log throttled to 10s while the condition persists", acted.filter(a => a[0] === "LOG").length, 1);
obs._liveDeckObserverTick(t0 + obs._foreignGraceMs() + 11000);
check("re-logs once the cadence elapses", acted.filter(a => a[0] === "LOG").length, 2);

// 12e) CART is not a rotation deck — it can never be seen as foreign, at any duration.
check("CART is never a foreign deck", obs._foreignPlayingDecks("B", { A: "paused", B: "playing", C: "paused", CART: "playing" }), []);

// 12f) The chain re-check: if a rotate made the foreign deck the LIVE deck between tick and turn,
//      the queued stop must abandon. Drive it by flipping liveDeck before the closure runs.
const late = [];
const obs2 = new DaemonEngine(99, {}, () => {});
obs2._log = () => {}; obs2._stop = (d) => late.push(d);
obs2._advance = (_w, fn) => { obs2.liveDeck = "A"; return fn(); };   // a rotate landed: A is now live
obs2.liveDeck = "C";
obs2.stateA = { status: "playing", title: "x", positionSec: 9, durationSec: 100 };
obs2.stateB = { status: "paused", title: "", positionSec: 0, durationSec: 0 };
obs2.stateC = { status: "playing", title: "y", positionSec: 9, durationSec: 100 };
obs2._deckState = (d) => (d === "A" ? obs2.stateA : d === "B" ? obs2.stateB : obs2.stateC);
obs2._foreignSince = 1;
obs2._liveDeckObserverTick(1 + obs2._foreignGraceMs() + 1);
check("a rotate between tick and turn cancels the queued stop", late, []);

// 13) the condition resolving is logged too, and the observer re-arms.
obs.stateA = { status: "ended", title: "Foreign", positionSec: 136.8, durationSec: 136.8 };
obs._liveDeckObserverTick(t0 + obs._foreignGraceMs() + 12000);
check("clearing is logged", /foreign deck cleared after/.test(acted[acted.length - 1][1]), true);
check("observer re-arms after clearing", obs._foreignSince, 0);

// 14) the tick can never throw into playout (same contract as _segueTick/_jingleTick).
obs._deckState = () => { throw new Error("boom"); };
obs.stateA = { status: "playing", title: "x", positionSec: 0, durationSec: 0 };
obs._foreignSince = 1; obs._foreignLastLogAt = 0;
let threw = false;
try { obs._liveDeckObserverTick(t0 + 99999); } catch { threw = true; }
check("tick swallows its own errors — playout unaffected", threw, false);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
