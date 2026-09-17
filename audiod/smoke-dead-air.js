// Bench for the DEAD-AIR LOOP of 2026-09-15/16 (docs/ovevents-crash-loop-alarm-2026-09-15.md §4/§5).
// Exercises the REAL DaemonEngine with the native addon stubbed at the four seams it touches
// (_load/_play/_stop/_state) — no audio, no DB, no daemon.   node audiod/smoke-dead-air.js   (exit 0 = pass)
//
// Two receipts from the field, each a case here:
//   (a) the calendar re-cue ran `await this.preload(B)` from INSIDE an _advance op → preload chained a
//       new op onto the promise that was awaiting it → the chain wedged for the whole song
//       (44 of 44 re-cues on OVEVENTS: `advance → recue:B` and never `advance done recue:B`).
//   (b) the stall recovery selected a deck on its TITLE; Rust's audio_stop had left the title on an
//       emptied deck; audio_play refused it; the refusal was ignored — status "playing", _fireStart,
//       a play_log row, "resume-playout: deck B LIVE" — every 2s until the top of the hour.
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
const playlog = require(path.join(__dirname, "playlog.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// The chain must settle on its own; a wedge shows up as this timeout, never as a hang of the bench.
function settled(p, ms) { return Promise.race([p.then(() => "settled"), sleep(ms).then(() => "TIMEOUT")]); }

/** A running engine with a fake Rust behind it. `rust` mirrors the addon's DeckMeta: load sets
 *  title/artist/file_path, stop clears ALL of them (lib.rs audio_stop, 2026-09-16), play refuses when
 *  file_path is empty (lib.rs audio_play, 2026-07-31). _state() feeds that back like audio_get_state. */
function rig() {
  const e = new DaemonEngine(2, {}, () => {});
  e.logs = [];
  e._log = (...a) => e.logs.push(a.join(" "));
  e.errors = [];
  e.emit = (ev, p) => { if (ev === "error") e.errors.push(p); };
  e._dur = () => 180;
  e._fileOk = (fp) => !!fp && !/missing/.test(fp);
  e._maybeEmitDeck = () => {};
  e._writeOperatorLogRow = () => {};
  e._started = true;
  e.continuous = false;
  e.rust = { A: { title: "", artist: "", file_path: "", status: "idle" }, B: { title: "", artist: "", file_path: "", status: "idle" }, C: { title: "", artist: "", file_path: "", status: "idle" } };
  e._load = (d, fp, title, artist) => { Object.assign(e.rust[d], { title, artist, file_path: fp, status: "idle" }); return true; };
  e._stop = (d) => { Object.assign(e.rust[d], { title: "", artist: "", file_path: "", status: "idle" }); return true; };
  e.plays = [];
  e._play = (d) => { if (!e.rust[d].file_path) { e.plays.push(d + ":REFUSED"); return false; } e.rust[d].status = "playing"; e.plays.push(d + ":ok"); return true; };
  e._state = () => ({ deckA: { ...e.rust.A }, deckB: { ...e.rust.B }, deckC: { ...e.rust.C } });
  // spies
  e.fireStarts = [];
  const origFire = e._fireStart.bind(e);
  e._fireStart = (d) => { e.fireStarts.push(d); return origFire(d); };
  return e;
}
// play_log spy — engine.js holds the same module object, so patching the export is enough.
let rows = [];
playlog.logPlay = (_db, row) => { rows.push(row); };

(async () => {
  console.log("── (a) THE RE-CUE COMPLETES — the chain does not wedge ──");
  {
    const e = rig();
    e._logReaderOn = () => true;
    e.segueOverlap = 3;
    // Deck A live with plenty of time left; deck B cued with the OLD row; the calendar's pending head is a different row.
    e._setDeckTrack("A", { title: "Live Song", filePath: "live.mp3", durationSec: 200, status: "playing" });
    e._setDeck("A", { status: "playing", positionSec: 20 });
    e.rust.A = { title: "Live Song", artist: "", file_path: "live.mp3", status: "playing" };
    e.stateA = { ...e.stateA, status: "playing" };
    e._setDeckTrack("B", { title: "Old Cue", filePath: "old.mp3", durationSec: 180, status: "idle" });
    e.rust.B = { title: "Old Cue", artist: "", file_path: "old.mp3", status: "idle" };
    e.deckReady.add("B");
    e.queue = e._ensureIds([{ title: "New Head", filePath: "new.mp3", schedId: 1 }, { title: "After", filePath: "after.mp3", schedId: 2 }]);
    e.boundQids.clear();

    e._resyncCuedDecks();
    const outcome = await settled(e.advanceP, 2000);
    check("a · the advance chain settled (no wedge)", outcome, "settled");
    check("a · 'advance → recue:B' was logged", e.logs.some(l => l.startsWith("advance → recue:B")), true);
    check("a · 'advance done recue:B' ARRIVED", e.logs.some(l => l.startsWith("advance done recue:B")), true);
    check("a · deck B is READY again", e.deckReady.has("B"), true);
    check("a · deck B holds the calendar's head row", e.stateB.filePath, "new.mp3");
    check("a · the wrapper preload() was NOT chained from inside the recue (no nested op)", e.logs.some(l => l.startsWith("advance → preload:B")), false);
    check("a · deck A untouched (still playing the same file)", [e.stateA.status, e.stateA.filePath], ["playing", "live.mp3"]);
    // And a second standby deck: C empty, deckReady not set → the recue skips it (preload fills it), no wedge either.
    const outcome2 = await settled(e.advanceP, 500);
    check("a · chain idle afterwards", outcome2, "settled");
  }

  console.log("\n── (a2) NEGATIVE CONTROL — the old shape (chained preload awaited from inside the op) DOES wedge ──");
  {
    const e = rig();
    e.queue = e._ensureIds([{ title: "X", filePath: "x.mp3" }]);
    e._advance("old-recue:B", async () => { await e.preload("B", 0); });
    const outcome = await settled(e.advanceP, 600);
    check("a2 · awaiting the chained wrapper from inside an op wedges (this is what 4.6.40–4.6.44 did)", outcome, "TIMEOUT");
    e.advanceP = Promise.resolve(); e._advanceStartedAt = 0;   // release the bench's chain
  }

  console.log("\n── (b) TITLE-ONLY DECK, RUST EMPTY — no phantom play; the queue loads onto A in ONE recovery ──");
  {
    const e = rig();
    rows = [];
    // The field state: Rust cleared B's file (old audio_stop kept the title; we model the WORST case —
    // a title lingering on our side while Rust has nothing).
    e._setDeckTrack("B", { title: "Ghost Song", filePath: "", durationSec: 0, status: "idle" });
    e.stateB = { ...e.stateB, title: "Ghost Song", filePath: "" };
    e.rust.B = { title: "Ghost Song", artist: "", file_path: "", status: "idle" };
    e.queue = e._ensureIds([{ title: "Next Real Song", filePath: "next.mp3", schedId: 7 }]);
    const airGenBefore = e._airGen;

    e._recoverStall();
    const outcome = await settled(e.advanceP, 2000);
    check("b · recovery settled", outcome, "settled");
    check("b · NO play_log row for the ghost deck", rows.filter(r => r.deck === "B").length, 0);
    check("b · NO 'resume-playout: deck B LIVE' line", e.logs.some(l => /resume-playout: deck B LIVE/.test(l)), false);
    check("b · _fireStart never ran for B", e.fireStarts.includes("B"), false);
    check("b · deck B never marked playing", e.stateB.status, "idle");
    check("b · deck A LOADED and PLAYING the queue's next row (same recovery, no retry needed)", [e.stateA.status, e.stateA.filePath, e.plays.includes("A:ok")], ["playing", "next.mp3", true]);
    check("b · exactly one play_log row, for A", rows.map(r => r.deck + ":" + r.title), ["A:Next Real Song"]);
    check("b · 'resume-playout: deck A LIVE' logged", e.logs.some(l => /resume-playout: deck A LIVE — Next Real Song/.test(l)), true);
    check("b · _airGen bumped exactly once (for A), not for the refusal", e._airGen - airGenBefore, 1);
    check("b · queue consumed", e.queue.length, 0);
    check("b · no REFUSED line (B was never even selected — filePath rules)", e.plays.includes("B:REFUSED"), false);
  }

  console.log("\n── (b2) RUST REFUSES A DECK WE THOUGHT HAD A FILE — the refusal is honoured, not painted over ──");
  {
    const e = rig();
    rows = [];
    // Our side says B has a file; Rust disagrees (the race the old code could not see).
    e._setDeckTrack("B", { title: "Ghost Song", filePath: "ghost.mp3", durationSec: 180, status: "idle" });
    e.rust.B = { title: "Ghost Song", artist: "", file_path: "", status: "idle" };
    e.deckReady.add("B");
    e.queue = e._ensureIds([{ title: "Next Real Song", filePath: "next.mp3", schedId: 8 }]);
    const airGenBefore = e._airGen;

    e._recoverStall();
    const outcome = await settled(e.advanceP, 2000);
    check("b2 · recovery settled", outcome, "settled");
    check("b2 · Rust refused B", e.plays.includes("B:REFUSED"), true);
    check("b2 · the refusal was LOGGED as a refusal", e.logs.some(l => /resume-playout: deck B REFUSED/.test(l)), true);
    check("b2 · an engine error was emitted for it", e.errors.some(x => x.where === "resume-playout" && x.deck === "B"), true);
    check("b2 · NO play_log row for B", rows.filter(r => r.deck === "B").length, 0);
    check("b2 · NO LIVE line for B", e.logs.some(l => /resume-playout: deck B LIVE/.test(l)), false);
    check("b2 · _fireStart never ran for B", e.fireStarts.includes("B"), false);
    check("b2 · B emptied on our side (no ghost title left to pick next time)", [e.stateB.title, e.stateB.filePath, e.deckReady.has("B")], ["", "", false]);
    check("b2 · fell through: deck A playing the queue's row", [e.stateA.status, e.stateA.filePath], ["playing", "next.mp3"]);
    check("b2 · one play_log row, for A", rows.map(r => r.deck), ["A"]);
    check("b2 · _airGen bumped once, for A only", e._airGen - airGenBefore, 1);
  }

  console.log("\n── (c) WATCHDOG: a title-only deck is not 'content' — no recovery fires for it with an empty queue ──");
  {
    const e = rig();
    e.stateB = { ...e.stateB, status: "idle", title: "Ghost Song", filePath: "" };
    e.queue = []; e.continuous = false;
    e._lastPlayingAt = Date.now() - 5000; e._watchdogArmed = true;
    e._watchdog();
    check("c · no STALL line — nothing to recover with", e.logs.some(l => /watchdog: STALL/.test(l)), false);
    // …but a deck WITH a file is content.
    e.stateB = { ...e.stateB, filePath: "real.mp3" };
    e.rust.B.file_path = "real.mp3";
    e._watchdog();
    check("c · with a file, the stall recovery fires", e.logs.some(l => /watchdog: STALL/.test(l)), true);
    await settled(e.advanceP, 1000);
  }

  console.log("\n── (d) PLAY NOW keeps its manual-cue preference for a hand-cued deck that HAS a file ──");
  {
    const e = rig();
    rows = [];
    e._setDeckTrack("C", { title: "Hand Cued", filePath: "hand.mp3", durationSec: 120, status: "idle" });
    e.rust.C = { title: "Hand Cued", artist: "", file_path: "hand.mp3", status: "idle" };
    e.manualCue.add("C");
    e._setDeckTrack("B", { title: "Auto Cued", filePath: "auto.mp3", durationSec: 120, status: "idle" });
    e.rust.B = { title: "Auto Cued", artist: "", file_path: "auto.mp3", status: "idle" };
    e.deckReady.add("B");
    e.queue = e._ensureIds([{ title: "Q", filePath: "q.mp3" }]);
    let r = null;
    e._advance("bench-playnow", async () => { r = await e._resumePlayout(); });
    await settled(e.advanceP, 1000);
    check("d · resumed on the HAND-CUED deck first", [r, e.stateC.status, e.plays[0]], [true, "playing", "C:ok"]);
    check("d · queue not dequeued against a manual cue", e.queue.length, 1);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
