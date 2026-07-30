// Bench for NEAREST-ANCHOR SEAM SELECTION (2026-07-30) — the real loggen.orderForNearestAnchor plus the
// engine's companion re-cue. NO audio, NO DB, NO daemon: safe to run anytime.
//   node audiod/smoke-nearest-anchor.js     (exit 0 = pass)
//
// THE RULE (Jeff): early or late does not matter — closest to the anchor wins.
//   air the spot NOW    → |seamTs − A|
//   air the music first → |(seamTs + d) − A|
// Design of record: docs/design-nearest-anchor-seam-selection-2026-07-30.md
"use strict";
const path = require("path");
const loggen = require(path.join(__dirname, "loggen.js"));
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
// Compact fixtures. t(...) builds an epoch second from a local wall-clock time on a fixed day.
const T = (h, m, s = 0) => { const d = new Date(2026, 6, 30, h, m, s); return Math.floor(d.getTime() / 1000); };
const music = (title, durSec, at) => ({ title, contentClass: "MUSIC", durationMs: durSec * 1000, scheduledAt: at, filePath: `${title}.mp3` });
const spot  = (title, durSec, at) => ({ title, contentClass: "SPOT",  durationMs: durSec * 1000, scheduledAt: at, filePath: `${title}.mp3` });
const titles = (arr) => arr.map(i => i.title);

console.log("── nearest-anchor selector (real loggen.orderForNearestAnchor) ──");

// ══ THE WORKED LIVE CASE — station 4, 2026-07-30, clock minute=0/20/40, anchor A = 11:19:50 ══
const A = T(11, 19, 50);
const liveItems = [music("WhatTheWorld", 211, T(11, 17, 18)), spot("Spot", 18, A), music("Next", 200, T(11, 23))];

// seam 11:17:18 — spot now = 152s early; music(211s) first = 220s late → MUSIC keeps the head.
check("worked case, seam 11:17:18 → music stays first (152s early beats nothing; 220s late loses)",
  titles(loggen.orderForNearestAnchor(liveItems, T(11, 17, 18))), ["WhatTheWorld", "Spot", "Next"]);

// The design's second row used a 164s song for the earlier seam; assert that shape directly:
//   seam 11:17:18, d=164 → spot now 152s early vs music first 12s late → MUSIC.
check("shorter song that lands ON the anchor → music wins (12s late beats 152s early)",
  titles(loggen.orderForNearestAnchor(
    [music("ChristmasInTheCity", 164, T(11, 17, 18)), spot("Spot", 18, A)], T(11, 17, 18))),
  ["ChristmasInTheCity", "Spot"]);

// seam 11:20:49 — spot now = 59s late; music(211s) first = 259s late → SPOT promoted.
check("worked case, seam 11:20:49 → SPOT promoted (59s late beats 259s late)",
  titles(loggen.orderForNearestAnchor(liveItems, T(11, 20, 49))), ["Spot", "WhatTheWorld", "Next"]);

// ══ §1 REACH — an anchor further away than one candidate song is not weighed ══
// d=100s, anchor 300s out → out of reach, untouched.
check("reach: anchor further than one song out → log order untouched",
  titles(loggen.orderForNearestAnchor([music("M", 100, 0), spot("S", 18, T(12, 5))], T(12, 0))), ["M", "S"]);
// Boundary: A − seamTs exactly == d → still in reach (the comparison is meaningful).
check("reach boundary: (A − seam) exactly == d → in reach, evaluated",
  titles(loggen.orderForNearestAnchor([music("M", 100, 0), spot("S", 18, T(12, 1, 40))], T(12, 0))), ["M", "S"]);
// One second beyond the boundary → out of reach.
check("reach boundary + 1s → out of reach, untouched",
  titles(loggen.orderForNearestAnchor([music("M", 100, 0), spot("S", 18, T(12, 1, 41))], T(12, 0))), ["M", "S"]);

// ══ PAST ANCHOR — an overdue spot is always in reach and must be promoted ══
check("past anchor (overdue spot) → promoted, waiting can only make it worse",
  titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, T(11, 0))], T(11, 5))), ["S", "M"]);

// ══ §2 NEAR-TIE — prefer log order, both directions ══
// seam=1000, A=1090, d=180 → now 90 late-ish (|1000−1090|=90), after |1180−1090|=90 → exact tie.
check("exact tie → log order (no promotion)",
  titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, 1090)], 1000)), ["M", "S"]);
// Difference of 2s — inside the tie band → still log order.
check("near-tie within 2s (spot marginally better) → log order, no flapping",
  titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, 1089)], 1000)), ["M", "S"]);
// Difference of 4s — a clear win → promote.
check("clear win beyond the tie band → promoted",
  titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, 1088)], 1000)), ["S", "M"]);
// The other direction: music clearly better → never promoted.
check("music clearly better → never promoted",
  titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, 1180)], 1000)), ["M", "S"]);

// ══ §3 MULTI-SPOT BLOCK — atomic, order preserved, compared on the FIRST anchor ══
const blockItems = [music("M", 300, 0), spot("S1", 18, 1000), spot("S2", 18, 1001), spot("S3", 18, 1002), music("M2", 200, 0)];
check("multi-spot break promotes as one block, order preserved",
  titles(loggen.orderForNearestAnchor(blockItems, 1000)), ["S1", "S2", "S3", "M", "M2"]);
// A spot far from the block's anchor is a DIFFERENT break — not swept in.
const twoBreaks = [music("M", 300, 0), spot("S1", 18, 1000), spot("Later", 18, 2200), music("M2", 200, 0)];
check("a distant spot is a separate break, not swept into the block",
  titles(loggen.orderForNearestAnchor(twoBreaks, 1000)), ["S1", "M", "Later", "M2"]);

// ══ §4 TOP OF HOUR — the hard cut owns :00; never pre-empt it ══
check(":00 anchor is out of scope — hard cut owns it",
  titles(loggen.orderForNearestAnchor(
    [music("M", 300, 0), spot("TopOfHour", 18, T(12, 0))], T(11, 58), { nextHourTs: T(12, 0) })),
  ["M", "TopOfHour"]);
check("an anchor BEFORE the next hour is still evaluated normally",
  titles(loggen.orderForNearestAnchor(
    [music("M", 300, 0), spot("S", 18, T(11, 58, 30))], T(11, 58), { nextHourTs: T(12, 0) })),
  ["S", "M"]);

// ══ DEGENERATE INPUTS — never throw, never invent ══
check("no spot → unchanged", titles(loggen.orderForNearestAnchor([music("A1", 100, 0), music("B1", 100, 0)], 1000)), ["A1", "B1"]);
check("no music → unchanged", titles(loggen.orderForNearestAnchor([spot("S1", 18, 1000), spot("S2", 18, 1000)], 1000)), ["S1", "S2"]);
check("spot already first → unchanged (nothing to promote)", titles(loggen.orderForNearestAnchor([spot("S", 18, 1000), music("M", 100, 0)], 1000)), ["S", "M"]);
check("single item → unchanged", titles(loggen.orderForNearestAnchor([music("M", 100, 0)], 1000)), ["M"]);
check("empty → unchanged", loggen.orderForNearestAnchor([], 1000), []);
check("non-array → returned as-is", loggen.orderForNearestAnchor(null, 1000), null);
check("unanchored spot (no scheduledAt) → never guess a time", titles(loggen.orderForNearestAnchor([music("M", 180, 0), { title: "S", contentClass: "SPOT", durationMs: 18000 }], 1000)), ["M", "S"]);
check("zero-duration music → cannot compare honestly, unchanged", titles(loggen.orderForNearestAnchor([music("M", 0, 0), spot("S", 18, 1000)], 1000)), ["M", "S"]);
check("NaN seam → unchanged", titles(loggen.orderForNearestAnchor([music("M", 180, 0), spot("S", 18, 1000)], NaN)), ["M", "S"]);
check("no-op returns the SAME array identity (callers detect a no-op cheaply)",
  (() => { const a = [music("M", 100, 0), music("N", 100, 0)]; return loggen.orderForNearestAnchor(a, 1000) === a; })(), true);

// ══ COMPANION RE-CUE — engine side. SPOT promotions only, UNSTARTED standby decks only ══
console.log("\n── companion re-cue (real DaemonEngine._recueForPromotedSpot) ──");

function rig({ liveDeck = "B", statuses, ready }) {
  const acted = [];
  const e = new DaemonEngine(99, {}, () => {});
  e._log = (...a) => acted.push(["LOG", a.join(" ")]);
  e.loadToDeck = (deck, item) => { acted.push(["LOAD", deck, item.title]); return true; };
  e.dequeue = () => acted.push(["DEQUEUE"]);
  e._maybeEmitDeck = () => {};
  e._stop = (d) => acted.push(["STOP", d]);
  e._play = (d) => acted.push(["PLAY", d]);
  e.liveDeck = liveDeck;
  e.stateA = { status: statuses.A, title: "cuedA", filePath: "a.mp3" };
  e.stateB = { status: statuses.B, title: "liveB", filePath: "b.mp3" };
  e.stateC = { status: statuses.C, title: "cuedC", filePath: "c.mp3" };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  e.deckReady = new Set(ready);
  return { e, acted };
}
const promotedSpot = { title: "Spot", contentClass: "SPOT", filePath: "spot.mp3", scheduledAt: 1000, durationMs: 18000 };

// 1) An unstarted, cued standby deck IS re-cued.
{
  const { e, acted } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e._recueForPromotedSpot(promotedSpot);
  check("unstarted cued standby deck is re-cued to the spot", acted.filter(a => a[0] === "LOAD"), [["LOAD", "A", "Spot"]]);
  check("…and the head is dequeued (it is on the deck now)", acted.some(a => a[0] === "DEQUEUE"), true);
  check("…and it is logged", acted.some(a => a[0] === "LOG" && /re-cued deck A to SPOT/.test(a[1])), true);
}
// 2) A PLAYING deck is never re-cued — even if it is not the live deck.
{
  const { e, acted } = rig({ statuses: { A: "playing", B: "playing", C: "ended" }, ready: ["A"] });
  e._recueForPromotedSpot(promotedSpot);
  check("a PLAYING deck is never re-cued", acted.some(a => a[0] === "LOAD"), false);
}
// 3) The live deck is never a target.
{
  const { e, acted } = rig({ liveDeck: "A", statuses: { A: "paused", B: "ended", C: "ended" }, ready: ["A"] });
  e._recueForPromotedSpot(promotedSpot);
  check("the LIVE deck is never re-cued", acted.some(a => a[0] === "LOAD" && a[1] === "A"), false);
}
// 4) No cued standby deck → nothing happens.
{
  const { e, acted } = rig({ statuses: { A: "ended", B: "playing", C: "ended" }, ready: [] });
  e._recueForPromotedSpot(promotedSpot);
  check("no cued standby deck → no re-cue", acted.filter(a => a[0] === "LOAD"), []);
}
// 5) A non-SPOT head is never acted on (this is a spot-only exception to the bound-head rule).
{
  const { e, acted } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e._recueForPromotedSpot({ title: "Song", contentClass: "MUSIC", filePath: "s.mp3", durationMs: 180000 });
  check("a MUSIC head is never re-cued (SPOT promotions only)", acted.filter(a => a[0] === "LOAD"), []);
}
// 6) Already holding that exact spot → idempotent, no reload.
{
  const { e, acted } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e.stateA = { status: "paused", title: "Spot", filePath: "spot.mp3" };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  e._recueForPromotedSpot(promotedSpot);
  check("deck already holds that spot → idempotent, no reload", acted.filter(a => a[0] === "LOAD"), []);
}
// 7) SCOPE INVARIANT — the re-cue may LOAD, never start or stop audio.
{
  const { e, acted } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e._recueForPromotedSpot(promotedSpot);
  check("re-cue never plays a deck", acted.some(a => a[0] === "PLAY"), false);
  check("re-cue never stops a deck", acted.some(a => a[0] === "STOP"), false);
}
// 8) A failing load leaves the previous cue intact.
{
  const { e, acted } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e.loadToDeck = () => false;
  e._recueForPromotedSpot(promotedSpot);
  check("a failed load leaves the previous cue (no dequeue, no state change)", acted.some(a => a[0] === "DEQUEUE"), false);
}
// 9) Never throws into playout.
{
  const { e } = rig({ statuses: { A: "paused", B: "playing", C: "ended" }, ready: ["A"] });
  e._deckState = () => { throw new Error("boom"); };
  let threw = false;
  try { e._recueForPromotedSpot(promotedSpot); } catch { threw = true; }
  check("re-cue swallows its own errors — playout unaffected", threw, false);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
