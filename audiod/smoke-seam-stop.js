// Bench for the deck-retire contract and the liveDeck guard. Exercises the REAL DaemonEngine methods
// with NO audio/DB/pipe, so it is safe to run anytime.
//
// THE INVARIANT, and it is the whole point of this file:
//
//     THE OUTGOING SONG ALWAYS PLAYS TO ITS NATURAL END.
//     A DECK THAT REPORTS PLAYING IS NEVER STOPPED, FOR ANY ELAPSED TIME.
//
// This suite previously asserted the opposite. It was built around a timed post-crossfade stop that
// FORCE-stopped a deck even while it reported playing — a delay calibrated in 7d2d159 (2026-05-05) for a
// rotate that happened at the deck's natural end, never revisited when segueOverlap moved the rotate
// earlier. With an overlap of 5 it cut 1.5s off the end of every segued song. The tests passed the whole
// time, which is why a suite asserting a retired contract is worse than no suite.
//
// What is UNCHANGED and still tested here: Bug A (a stop must never wipe a freshly re-loaded source, and
// must never touch the incoming deck), and the liveDeck guard (a deck the engine did not put on air is
// stopped past a grace — the 2026-07-30 two-decks incident).
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

console.log("── retire OWNERSHIP (real DaemonEngine._outgoingStopAction; no audio/DB) ──");
// _outgoingStopAction answers ONE question: does this deck still belong to the rotate that queued its
// retire? It is an ownership test, NOT a stop order — _retireTick decides whether the deck has drained,
// and that is where the "never stop audio" contract lives (next section).
const e = new DaemonEngine(99, {}, () => {});
e.deckGen = { A: 5, B: 2, C: 0 };

// 1) the outgoing deck, same source since the rotate (deckGen 5==5), not the incoming (toId=B) → it is
//    still ours to retire. Play status is irrelevant to OWNERSHIP.
e._deckState = () => ({ status: "playing" });
check("same source, not the target → still ours to retire", e._outgoingStopAction("A", 5, "B"), "stop");

// 2) a FRESH source was loaded onto A since the rotate (deckGen bumped 5→ was 4) → never wipe it.
check("reloaded since rotate (deckGen changed) → skip-reloaded", e._outgoingStopAction("A", 4, "B"), "skip-reloaded");

// 3) fromId IS the deck we rotated INTO → never stop the incoming/live deck.
check("is the incoming deck (fromId===toId) → skip-target", e._outgoingStopAction("A", 5, "A"), "skip-target");

// 4) normal segue: the outgoing deck already ended, same source → stop (cleanup).
e._deckState = () => ({ status: "ended" });
check("normal: outgoing ended, same source → stop", e._outgoingStopAction("A", 5, "B"), "stop");

// 5) OWNERSHIP is independent of play status — deliberately. The two questions are separate: this one
//    asks "is this deck still ours", _retireTick asks "has it finished". Conflating them is what let a
//    clock stop a playing deck.
e._deckState = () => ({ status: "playing" }); const whilePlaying = e._outgoingStopAction("A", 5, "B");
e._deckState = () => ({ status: "ended" });   const whileEnded   = e._outgoingStopAction("A", 5, "B");
check("ownership is independent of play-status (the two questions stay separate)", whilePlaying === "stop" && whileEnded === "stop", true);

// ── THE CONTRACT: a deck with audio is never stopped ─────────────────────────────────────────────
console.log("\n── retire CONTRACT (real DaemonEngine._retireTick) ──");
const mk = (status) => {
  const acted = [];
  const r = new DaemonEngine(99, {}, () => {});
  r._log = (...a) => acted.push(["LOG", a.join(" ")]);
  r._stop = (d) => acted.push(["STOP", d]);
  r._play = (d) => acted.push(["PLAY", d]);
  r._load = (d) => acted.push(["LOAD", d]);
  r.handleRotate = (f, t) => acted.push(["ROTATE", f, t]);
  r._advance = (where, fn) => { acted.push(["ADVANCE", where]); return fn(); };
  r.emit = (...a) => acted.push(["EMIT", a[1] && a[1].where]);
  r.deckGen = { A: 5, B: 2, C: 0 };
  r._deckState = () => ({ status });
  r._retiring.set("A", { gen: 5, toId: "B", since: 1000, warned: false });
  return { r, acted };
};

// 15) THE ONE THAT MATTERS. A playing deck is not stopped one second after the rotate, nor ten, nor ten
//     minutes. There is no elapsed time at which the engine takes a song off.
{
  const { r, acted } = mk("playing");
  for (const t of [1001, 2000, 4500, 10000, 60000, 600000]) r._retireTick(t);
  check("a PLAYING deck is never stopped, at any elapsed time", acted.some(a => a[0] === "STOP"), false);
  check("  …and it stays queued for retirement", r._retiring.has("A"), true);
}

// 16) the old behaviour, pinned so it cannot come back: at the moment the retired timer would have fired
//     (crossfadeDuration*1000 + 500 = 3500ms), a playing deck is still untouched.
{
  const { r, acted } = mk("playing");
  r._retireTick(1000 + r.crossfadeDuration * 1000 + 500);
  check("at the retired timer's moment (cf+500ms): still playing, still untouched", acted.filter(a => a[0] === "STOP").length, 0);
}

// 17) once it has actually drained, it IS retired — on the chain, with the bookkeeping.
{
  const { r, acted } = mk("ended");
  r.deckReady.add("A"); r.endTriggered.add("A");
  r._retireTick(1200);
  check("a DRAINED deck is retired", acted.filter(a => a[0] === "STOP").map(a => a[1]), ["A"]);
  check("  …on the advance chain", acted.some(a => a[0] === "ADVANCE" && a[1] === "stop:A"), true);
  check("  …deckReady cleared (Bug A: never leave a nulled source marked ready)", r.deckReady.has("A"), false);
  check("  …endTriggered cleared", r.endTriggered.has("A"), false);
  check("  …and it leaves the retire map", r._retiring.has("A"), false);
}

// 18) BUG A, unchanged: a deck re-loaded since the rotate is never stopped, drained or not.
{
  const { r, acted } = mk("ended");
  r.deckGen.A = 6;                                   // a fresh source landed since the rotate
  r._retireTick(9999);
  check("Bug A: a re-loaded deck is never stopped", acted.some(a => a[0] === "STOP"), false);
  check("  …and it is dropped from the retire map", r._retiring.has("A"), false);
}

// 19) never the incoming deck.
{
  const { r, acted } = mk("ended");
  r._retiring.set("A", { gen: 5, toId: "A", since: 1000, warned: false });
  r._retireTick(9999);
  check("the deck we rotated INTO is never stopped", acted.some(a => a[0] === "STOP"), false);
}

// 20) a deck that never drains is REPORTED, once, and still not stopped.
{
  const { r, acted } = mk("playing");
  r._retireTick(1000 + r._foreignGraceMs() + 1);
  r._retireTick(1000 + r._foreignGraceMs() + 5000);
  check("a deck that will not drain is reported exactly once", acted.filter(a => a[0] === "LOG").length, 1);
  check("  …the line says it is NOT being stopped", /NOT stopping it/.test((acted.find(a => a[0] === "LOG") || [])[1] || ""), true);
  check("  …a health event is emitted", acted.some(a => a[0] === "EMIT" && a[1] === "deck-retire-slow"), true);
  check("  …and it is STILL not stopped", acted.some(a => a[0] === "STOP"), false);
}

// 21) the retire is not an actuator for anything else.
{
  const { r, acted } = mk("ended");
  r._retireTick(9999);
  check("retire never plays a deck", acted.some(a => a[0] === "PLAY"), false);
  check("retire never loads a deck", acted.some(a => a[0] === "LOAD"), false);
  check("retire never issues a rotate", acted.some(a => a[0] === "ROTATE"), false);
}

// 22) an OPERATOR cut is still a hard stop — a person asked for that audio to come off now.
{
  const { r, acted } = mk("playing");
  r._retireDeck("A", "operator-cut");
  check("an operator cut still stops a playing deck", acted.filter(a => a[0] === "STOP").map(a => a[1]), ["A"]);
}

// 23) empty map is free, and the tick never throws into playout.
{
  const { r } = mk("ended");
  r._retiring.clear();
  let threw = false; try { r._retireTick(1); } catch { threw = true; }
  check("empty retire map: no work, no throw", threw, false);
}

// 24) SEGUE OVERLAP IS THE OPERATOR'S — no literal in the engine. A fresh engine starts at 0, which
//     means "no early rotate" until the station's number arrives: the fail-safe direction.
{
  const fresh = new DaemonEngine(99, {}, () => {});
  check("no hardcoded segue overlap — a fresh engine starts at 0 (no early rotate)", fresh.segueOverlap, 0);
}

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

// 10) a legitimate segue overlap must NOT be reportable: the grace has to outlast the window in which
//     the outgoing deck is normally still playing its own tail.
check("grace outlasts a normal segue overlap", o._foreignGraceMs() > o.crossfadeDuration * 1000 + 500, true);
o.segueOverlap = 6; o.crossfadeDuration = 5;
check("grace is DERIVED from the settings, not hardcoded", o._foreignGraceMs(), (6 + 5) * 1000 + 1500);
o.segueOverlap = 3; o.crossfadeDuration = 3;   // set explicitly: the engine no longer carries a default

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
// AUTO: the guard ENFORCES only while automation is deciding. In MANUAL it observes and never stops a
// jock's deliberate second deck (docs/design-manual-mode-contract-2026-07-31.md) - covered by
// audiod/smoke-manual-mode.js. This bench is the AUTO case, so automation is engaged.
obs._started = true;
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
// Hold it across the whole window a real overlap occupies, including the moment the retired timed stop
// used to fire (cf+500ms = 3500ms) — the guard must not have inherited that clock either.
obs._liveDeckObserverTick(t0 + 3500);
check("at the retired timer's moment (cf+500ms): still untouched", acted.length, 0);
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
