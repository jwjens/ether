// Bench for the SAMPLE CLOCK position authority (2026-08-09). Position used to be extrapolated from
// Date.now() on both sides of the process boundary, so the playhead drifted from the audio it claimed
// to describe. Rust now counts the frames it actually pulls per deck (DeckSlot.frames_played) and
// publishes them on the levels payload; that count is the AUTHORITY, wall-clock is the fallback.
//   node audiod/smoke-deck-position.js   (exit 0 = pass)
//
// Exercises the REAL DaemonEngine._derivePosition. No audio, no DB, no daemon, no sound card — the
// frame counts are injected exactly as _readLevels would stash them.
//
// THE HEADLINE CASE IS DECK INDEPENDENCE. A single stream-global counter (the shape the original
// task spec asked for) reports the same number for every deck, so during a crossfade both decks
// claim the same position and the segue fires against a number that belongs to neither. Case 5 is
// the one that would catch a regression back to a shared counter.
//
// Design: docs/sample-accurate-position-design-2026-08-09.md
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const R = 44100;
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

/** An engine with deck A on air at 10.0s by the OLD wall-clock reckoning. */
function rig() {
  const events = [];
  const e = new DaemonEngine(2, {}, (ev, payload) => events.push([ev, payload]));
  e._log = () => {};
  e.stateA = { ...e.stateA, status: "playing", title: "Track A", filePath: "a.mp3", positionSec: 10, durationSec: 200 };
  e.stateB = { ...e.stateB, status: "playing", title: "Track B", filePath: "b.mp3", positionSec: 3,  durationSec: 200 };
  return { e, events };
}
/** Inject frame counts exactly as _readLevels stashes them. */
function frames(e, map, at) { e._deckFrames = map; e._deckFramesAt = at; }

// ── 1. Fresh frames → the sample clock is the authority, wall is carried alongside ───────────────
{
  const { e, events } = rig();
  const now = Date.now();
  frames(e, { A: 12 * R }, now);
  const d = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);

  check("1a sample position wins",        round(d.positionSec),     12);
  check("1b wall estimate carried",       round(d.positionSecWall),  10.25);
  check("1c drift reported (ms)",         Math.round(d.positionDriftMs), 1750);
  check("1d authority declared on first read",
        events.filter(([ev]) => ev === "position-authority").map(([, p]) => p.authority), ["sample"]);
}

// ── 2. Stale levels → falls back to wall clock AND SAYS SO ──────────────────────────────────────
// A silent degrade is the failure mode this guards: wall-clock output that looks measured.
{
  const { e, events } = rig();
  const now = Date.now();
  frames(e, { A: 12 * R }, now - 3000);           // older than FRAMES_STALE_MS (2000)
  const d = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);

  check("2a falls back to wall",          round(d.positionSec),   10.25);
  check("2b no drift computable",         d.positionDriftMs,      null);
  const ev = events.find(([x]) => x === "position-authority")[1];
  check("2c degrade is announced",        [ev.authority, ev.reason], ["wall", "levels-stale"]);
}

// ── 3. Recovery re-announces — the flip back is as loud as the flip away ────────────────────────
{
  const { e, events } = rig();
  const now = Date.now();
  frames(e, { A: 12 * R }, now - 3000);
  e._derivePosition("A", { status: "playing" }, 200, 0.25, now);   // → wall
  frames(e, { A: 13 * R }, now);                                   // levels return
  const d = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);

  check("3a sample authority resumes",    round(d.positionSec), 13);
  check("3b both transitions announced",
        events.filter(([x]) => x === "position-authority").map(([, p]) => p.reason),
        ["levels-stale", "sample-clock-restored"]);
}

// ── 4. No flapping — a steady authority emits once, not every tick ──────────────────────────────
{
  const { e, events } = rig();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    frames(e, { A: (12 + i) * R }, now + i);
    e._derivePosition("A", { status: "playing" }, 200, 0.25, now + i);
  }
  check("4a one announcement across 5 steady ticks",
        events.filter(([x]) => x === "position-authority").length, 1);
}

// ── 5. HEADLINE: two decks report INDEPENDENT positions (the crossfade case) ────────────────────
// A stream-global counter would return the same number for both. This is the regression guard.
{
  const { e } = rig();
  const now = Date.now();
  frames(e, { A: 30 * R, B: 5 * R }, now);
  const a = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);
  const b = e._derivePosition("B", { status: "playing" }, 200, 0.25, now);

  check("5a deck A independent",          round(a.positionSec), 30);
  check("5b deck B independent",          round(b.positionSec),  5);
}

// ── 6. Pause holds position — frames stop advancing, so position stops ──────────────────────────
{
  const { e } = rig();
  const now = Date.now();
  frames(e, { A: 12 * R }, now);
  const first = e._derivePosition("A", { status: "paused" }, 200, 0.25, now);
  frames(e, { A: 12 * R }, now + 250);                             // Rust pulled nothing while paused
  const second = e._derivePosition("A", { status: "paused" }, 200, 0.25, now + 250);

  check("6a position frozen while paused", [round(first.positionSec), round(second.positionSec)], [12, 12]);
}

// ── 7. A deck that just started reads ~0 legitimately and must NOT be treated as a fault ────────
{
  const { e } = rig();
  const now = Date.now();
  e.stateA = { ...e.stateA, positionSec: 0.2 };                    // barely into the track
  frames(e, { A: 0 }, now);
  const d = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);
  check("7a zero at track start trusted",  round(d.positionSec), 0);
}

// ── 8. …but a zero after we believed we were seconds in IS a fault → fall back ──────────────────
{
  const { e, events } = rig();
  const now = Date.now();
  frames(e, { A: 0 }, now);                                        // stateA.positionSec is 10
  const d = e._derivePosition("A", { status: "playing" }, 200, 0.25, now);
  check("8a suspicious zero rejected",     round(d.positionSec), 10.25);
  const ev = events.find(([x]) => x === "position-authority")[1];
  check("8b reason is honest",             ev.reason, "counter-zero-while-playing");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
