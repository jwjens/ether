// Bench for the DECK ON contract (2026-08-02) — ON is now the only start control, and it is a SAFETY
// control. Exercises the REAL DaemonEngine. No audio, no DB, no daemon.
//   node audiod/smoke-xfade-contract.js   (exit 0 = pass)
//
// THE HEADLINE CASE IS THE OUT-OF-CHAIN REGRESSION. Before this, ON called getDeck(slot).play() — a raw
// audioPlay straight to Rust (App.tsx:3924), outside the advance chain: no serialization, no guards, no
// stop of the outgoing, no liveDeck update. That is the exact shape that put two decks on air on
// 2026-07-29. Every start must now go through _advance.
//
// Contract (Jeff): skip to the next track NOW without leaving AUTO. (1) outgoing off fast, incoming
// takes over immediately; (2) automation absorbs it; (3) deck state truthful; (4) rapid presses safe.
// Trace/design: docs/auto-xfade-contract-trace-2026-08-02.md
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A engine with deck A on air and deck B cued — the state ON is pressed against. */
function rig({ started = true, aPlaying = true, bReady = true } = {}) {
  const acted = [];
  const e = new DaemonEngine(2, {}, () => {});
  e._log = (...a) => acted.push(["LOG", a.join(" ")]);
  e._play = (d) => { acted.push(["PLAY", d]); if (["A","B","C"].includes(d)) e.liveDeck = d; };
  e._stop = (d) => acted.push(["STOP", d]);
  e._load = (d) => { acted.push(["LOAD", d]); return true; };
  e.preload = (d) => { acted.push(["PRELOAD", d]); return Promise.resolve(); };
  e.refillIfNeeded = () => { acted.push(["REFILL"]); return Promise.resolve(); };
  e._fireStart = (d) => acted.push(["FIRESTART", d]);
  e._maybeEmitDeck = () => {};
  e.dequeue = () => { acted.push(["DEQUEUE"]); return e.queue.shift(); };
  e._started = started;
  e.stateA = { id: "A", status: aPlaying ? "playing" : "idle", title: "On Air", filePath: "a.mp3", positionSec: 30, durationSec: 200, volume: 1 };
  e.stateB = { id: "B", status: "idle", title: "Cued Next", filePath: "b.mp3", positionSec: 0, durationSec: 180, volume: 1 };
  e.stateC = { id: "C", status: "idle", title: "", filePath: "", positionSec: 0, durationSec: 0, volume: 1 };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  // Rust's view, which the spurious-end guard reads.
  e._state = () => ({ deckA: { status: e.stateA.status }, deckB: { status: e.stateB.status }, deckC: { status: e.stateC.status } });
  if (bReady) e.deckReady.add("B");
  e.liveDeck = aPlaying ? "A" : null;
  e.queue = [{ title: "later", filePath: "l.mp3", durationMs: 120000, qid: "q1" }];
  return { e, acted };
}

(async () => {

console.log("── 1 · THE REGRESSION: every start goes through the advance chain, never a raw play ──");
{
  const { e, acted } = rig();
  let advanced = 0;
  const realAdvance = e._advance.bind(e);
  e._advance = (where, fn) => { advanced++; acted.push(["ADVANCE", where]); return realAdvance(where, fn); };
  await e.intentCrossfade(undefined, "B");
  check("1 · the start ran on the advance chain", advanced > 0, true);
  check("1 · the incoming deck was played", acted.some(a => a[0] === "PLAY" && a[1] === "B"), true);
  check("1 · …and every PLAY happened inside an ADVANCE", acted.findIndex(a => a[0] === "ADVANCE") < acted.findIndex(a => a[0] === "PLAY"), true);
  check("1 · liveDeck follows the new deck (it never updated on the old raw path)", e.liveDeck, "B");
}

console.log("\n── 2 · take-over: the outgoing is stopped, via the deferred Bug-A stop ──");
{
  const { e, acted } = rig();
  const r = await e.intentCrossfade(undefined, "B");
  check("2 · honest result", { ok: r.ok, reason: r.reason }, { ok: true, reason: "took-over" });
  check("2 · outgoing NOT stopped synchronously (the deferred stop owns it)", acted.some(a => a[0] === "STOP"), false);
  await sleep(900);   // SAFETY_CUT_MS (300) + the deferred stop's own 500ms guard window
  check("2 · outgoing stopped on the SAFETY cut", acted.some(a => a[0] === "STOP" && a[1] === "A"), true);
}
{
  // The contrast that gives the number meaning: a ROUTINE segue keeps its 3s musical overlap, so at the
  // same moment its outgoing deck is still up. Safety skip ≠ musical segue, on one shared code path.
  const { e, acted } = rig();
  e.handleRotate("A", "B");
  await sleep(900);
  check("2 · a routine segue at the same moment has NOT cut the outgoing", acted.some(a => a[0] === "STOP"), false);
}

console.log("\n── 3 · rapid double-press: ONE rotate, and the second press is HONEST about it ──");
{
  const { e, acted } = rig();
  const [r1, r2] = await Promise.all([e.intentCrossfade(undefined, "B"), e.intentCrossfade(undefined, "B")]);
  check("3 · exactly one deck was played", acted.filter(a => a[0] === "PLAY").length, 1);
  check("3 · first press took over", r1.ok, true);
  check("3 · second press reports FAILURE, not a silent success", r2.ok, false);
  check("3 · …and says why", r2.reason, "already-live");
}

console.log("\n── 4 · hammer: five presses, still one rotate ──");
{
  const { e, acted } = rig();
  const rs = await Promise.all(Array.from({ length: 5 }, () => e.intentCrossfade(undefined, "B")));
  check("4 · one PLAY across five presses", acted.filter(a => a[0] === "PLAY").length, 1);
  check("4 · exactly one press reported success", rs.filter(r => r.ok).length, 1);
  check("4 · no third deck was touched", acted.some(a => a[0] === "PLAY" && a[1] === "C"), false);
}

console.log("\n── 5 · deck identity survives the operator rotate (4.4.120 rule holds through it) ──");
{
  const { e } = rig();
  await e.intentCrossfade(undefined, "B");
  check("5 · title is the incoming track's", e.stateB.title, "Cued Next");
  check("5 · duration is the incoming track's, not the outgoing's", e.stateB.durationSec, 180);
  check("5 · position reset", e.stateB.positionSec, 0);
}

console.log("\n── 6 · play-skip guard: a target with no source is never silently played ──");
{
  const { e, acted } = rig({ bReady: false });
  const r = await e.intentCrossfade(undefined, "B");
  check("6 · refused — target not cued", { ok: r.ok, reason: r.reason }, { ok: false, reason: "target-not-cued" });
  check("6 · nothing was played", acted.some(a => a[0] === "PLAY"), false);
}

console.log("\n── 7 · MANUAL: the rotate fires, but NOTHING auto-cues ──");
{
  const { e, acted } = rig({ started: false });
  const r = await e.intentCrossfade(undefined, "B");
  check("7 · the operator's start still works in MANUAL", r.ok, true);
  check("7 · the deck played", acted.some(a => a[0] === "PLAY" && a[1] === "B"), true);
  await sleep(500);
  check("7 · NO preload fired (the jock owns the hour)", acted.some(a => a[0] === "PRELOAD"), false);
  check("7 · NO refill fired", acted.some(a => a[0] === "REFILL"), false);
}
{
  const { e, acted } = rig({ started: true });
  await e.intentCrossfade(undefined, "B");
  await sleep(1000);
  check("7 · AUTO by contrast DOES re-arm preloads", acted.some(a => a[0] === "PRELOAD"), true);
  check("7 · …and refills on this target letter (symmetric, was A-only)", acted.some(a => a[0] === "REFILL"), true);
}

console.log("\n── 8 · ON on a PLAYING deck = board-style STOP, not pause ──");
{
  const { e, acted } = rig();
  const r = await e.intentDeckOff("A");
  check("8 · honest result", { ok: r.ok, reason: r.reason }, { ok: true, reason: "stopped" });
  check("8 · the channel was STOPPED", acted.filter(a => a[0] === "STOP"), [["STOP", "A"]]);
  check("8 · deck reads idle, not paused", e.stateA.status, "idle");
  check("8 · liveDeck cleared", e.liveDeck, null);
}

console.log("\n── 9 · cold start: nothing on air → guarded start, still on the chain ──");
{
  const { e, acted } = rig({ aPlaying: false });
  const r = await e.intentCrossfade(undefined, "B");
  check("9 · started", { ok: r.ok, reason: r.reason }, { ok: true, reason: "started" });
  check("9 · played the cued deck", acted.some(a => a[0] === "PLAY" && a[1] === "B"), true);
  check("9 · nothing was stopped (there was no outgoing)", acted.some(a => a[0] === "STOP"), false);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
})();
