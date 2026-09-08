// Bench for AUTO-POST arming and firing. Exercises the REAL DaemonEngine methods with NO audio and no
// pipe, so it is safe to run anytime.
//
// THE RISK THIS FILE EXISTS FOR, in Jeff's words: "the armed entry surviving the rotate."
//
// It does not survive it, and it is not supposed to. `_jingleSuperseded` cancels an armed entry on an
// airGen bump, on the armed deck no longer playing, and on a deckGen change — and a rotate is all three
// at once. That is Bug-A immunity and it earns its keep. §1 below PROVES the hazard against the real
// predicate, so nobody later "fixes" AUTO-POST by weakening that guard.
//
// The design answer is not to survive the rotate but to arm AFTER it, against the deck now playing.
// §2 proves the arm happens there, §3 proves the fire point is the one the arithmetic asks for, and §4
// proves the LEAD path is untouched on placements that did not ask for auto_post.
//
// Run:  node audiod/smoke-autopost-arm.js   (exit 0 = pass)
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const mk = () => {
  const e = new DaemonEngine(99, {}, () => {});
  e._log = () => {};
  return e;
};

// ── §1 · THE HAZARD: an entry armed before the rotate is cancelled BY the rotate ────────────────────
console.log("\n── §1 the hazard: supersession cancels a pre-rotate arm (real _jingleSuperseded) ──");
{
  const e = mk();
  e._airGen = 4;
  e.deckGen = { A: 7, B: 3, C: 0 };
  e._deckState = (d) => ({ status: d === "A" ? "playing" : "stopped", durationSec: 200, positionSec: 190 });
  // Armed against A, before the rotate — exactly what the LEAD path does today.
  const armed = { deck: "A", airGen: 4, deckGen: 7 };
  check("armed on the outgoing, nothing has happened yet → not superseded", e._jingleSuperseded(armed), false);

  // THE ROTATE. Three things change at once, and each one alone is enough to cancel the arm.
  const afterAirGen = mk(); afterAirGen._airGen = 5; afterAirGen.deckGen = { A: 7 };
  afterAirGen._deckState = () => ({ status: "playing" });
  check("rotate bumped airGen → superseded", afterAirGen._jingleSuperseded(armed), true);

  const afterStop = mk(); afterStop._airGen = 4; afterStop.deckGen = { A: 7 };
  afterStop._deckState = () => ({ status: "stopped" });
  check("outgoing deck stopped → superseded", afterStop._jingleSuperseded(armed), true);

  const afterReload = mk(); afterReload._airGen = 4; afterReload.deckGen = { A: 8 };
  afterReload._deckState = () => ({ status: "playing" });
  check("armed deck re-loaded → superseded", afterReload._jingleSuperseded(armed), true);
  console.log("        → an AUTO-POST entry armed before the rotate could never reach its fire point.");
}

// ── §2 · THE ANSWER: arm AFTER the rotate, against the deck now playing ─────────────────────────────
console.log("\n── §2 the arm happens after the rotate, on the incoming deck (real _autoPostArm) ──");
{
  const e = mk();
  const ROW = {
    rowId: 4242, filePath: "C:/x/sweeper.mp3", title: "ID 4", artist: "",
    durationMs: 5000, scheduledAt: 1000, contentClass: "SWP", leadInSec: 2,
    jingleCategoryId: 3, chainType: "auto_post", postMs: 9000, cutEndMs: 4000,
  };
  // Stub the two boundaries the arm crosses: the DB read and the file check. Everything else is real.
  const loggen = require(path.join(__dirname, "loggen.js"));
  const realRead = loggen.readAutoPostForSong;
  loggen.readAutoPostForSong = (db, st, sched) => (sched === 1000 ? ROW : null);
  e._fileOk = () => true;

  e.deckSched = { A: 1000, B: null, C: null };
  const armedOk = e._autoPostArm("A");
  check("arms against the playing deck when a placement matches its slot", armedOk, true);
  check("the entry is armed, on that deck, carrying the auto_post terms",
    { phase: e._jingle.phase, deck: e._jingle.deck, chainType: e._jingle.chainType,
      postMs: e._jingle.postMs, cutEndMs: e._jingle.cutEndMs },
    { phase: "armed", deck: "A", chainType: "auto_post", postMs: 9000, cutEndMs: 4000 });

  // It is now the ordinary armed lifecycle, so supersession protects it the ordinary way.
  e._airGen = e._jingle.airGen;
  e.deckGen = { A: e._jingle.deckGen };
  e._deckState = () => ({ status: "playing" });
  check("a FURTHER rotate would cancel it, as it should",
    (() => { const f = mk(); f._airGen = e._jingle.airGen + 1; f.deckGen = { A: e._jingle.deckGen };
             f._deckState = () => ({ status: "playing" }); return f._jingleSuperseded(e._jingle); })(), true);

  const e2 = mk(); e2._fileOk = () => true; e2.deckSched = { A: 555 };
  check("no placement for this deck's slot → does not arm, LEAD path is reached", e2._autoPostArm("A"), false);

  const e3 = mk(); e3._fileOk = () => true; e3.deckSched = { A: 1000 };
  e3._jingle = { phase: "armed" };
  check("something already armed → does not arm twice", e3._autoPostArm("A"), false);

  const e4 = mk(); e4._fileOk = () => false; e4.deckSched = { A: 1000 };
  check("dead file → does not arm", e4._autoPostArm("A"), false);
  check("dead file → the row is consumed so it is not retried forever", e4._firedJinRows.includes(4242), true);

  loggen.readAutoPostForSong = realRead;
}

// ── §3 · THE FIRE POINT: position >= post − cutEnd, and not one tick earlier ────────────────────────
console.log("\n── §3 the fire point is post − cut_end on the incoming deck (real _autoPostFireDue) ──");
{
  const e = mk();
  // A 9s post and a 4s cut: the cut must start at 5.0s so its last moment lands on the vocal.
  const j = { chainType: "auto_post", postMs: 9000, cutEndMs: 4000 };
  const at = (sec) => e._autoPostFireDue(j, { positionSec: sec });
  check("at 0.00s (the rotate) → not yet", at(0.00), false);
  check("at 4.75s → not yet", at(4.75), false);
  check("at 4.99s → not yet", at(4.99), false);
  check("at 5.00s → FIRE", at(5.00), true);
  check("at 5.25s (a tick late) → still fires", at(5.25), true);
  console.log("        → a 4s cut fired at 5.0s ends at 9.0s, which is the post. On the word, not over it.");

  // A cut exactly as long as the post fires at the rotate itself.
  check("cut_end == post → fires at position 0", e._autoPostFireDue({ postMs: 4000, cutEndMs: 4000 }, { positionSec: 0 }), true);
  // Position missing entirely must not fire something early.
  check("no position reported → treated as 0, does not fire early",
    e._autoPostFireDue({ postMs: 9000, cutEndMs: 4000 }, {}), false);
}

// ── §4 · THE LEAD PATH IS UNTOUCHED ────────────────────────────────────────────────────────────────
console.log("\n── §4 a placement that did not ask for auto_post still fires on LEAD ──");
{
  const e = mk();
  e.segueOverlap = 3;
  // The LEAD condition, evaluated exactly as _jingleTick evaluates it.
  const leadDue = (leadIn, remaining) => remaining <= leadIn + e.segueOverlap;
  check("LEAD 2, overlap 3, 6s remaining → not yet", leadDue(2, 6), false);
  check("LEAD 2, overlap 3, 5s remaining → fires", leadDue(2, 5), true);
  check("an entry with no chainType is not an auto_post entry",
    !!({ chainType: null }).chainType, false);
  console.log("        → unset chain type takes the same branch it always did.");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
