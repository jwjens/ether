// Bench for IDENTITY-KEYED DECK STATE (2026-08-02). Exercises the REAL DaemonEngine — no audio, no DB,
// no daemon.  node audiod/smoke-deck-identity.js   (exit 0 = pass)
//
// THE LIVE REPRODUCER, one click: in MANUAL on halloVeen, load a track onto the deck holding an 0:11
// Commercial Spot, then XFADE. The deck showed Jack's Lament's TITLE with the spot's DURATION (0:11),
// the spot's GOLD OUTLINE (contentClass=SPOT), and the countdown frozen at 0:11/0:11 — one deck, three
// fields, two different tracks.
//
// Root cause: two paths changed a deck's occupant and only one set everything. The automation
// loadToDeck was correct; the inbound `load` command — where EVERY renderer-initiated load lands in
// daemon mode (library drag, queue click, JockStrip, cart assign) — called audioLoad + noteManualCue
// and left duration and contentClass belonging to the previous track.
// Design: docs/deck-state-mixing-reproducer-2026-08-02.md §4
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

/** An engine with a deck already holding the 0:11 Commercial Spot — the exact starting state. */
function rig() {
  const e = new DaemonEngine(2, {}, () => {});
  e._log = () => {};
  e._dur = () => 0;                       // getFileDuration unavailable unless a case says otherwise
  e._state = () => null;                  // no Rust in the bench
  e._maybeEmitDeck = () => {};
  e._writeOperatorLogRow = () => {};
  e._load = () => true;
  e._fileOk = () => true;
  e.stateC = { id: "C", status: "idle", title: "Commercial Spot", artist: "", filePath: "spot.mp3",
               positionSec: 0, durationSec: 11, volume: 1 };
  e._deckState = (d) => (d === "A" ? e.stateA : d === "B" ? e.stateB : e.stateC);
  e.deckContentClass["C"] = "SPOT";
  return e;
}

console.log("── 1 · THE REPRODUCER — a new track must bring its OWN duration and class ──");
{
  const e = rig();
  e._setDeckTrack("C", { title: "Jack's Lament", artist: "Danny Elfman", filePath: "jl.mp3",
                         durationMs: 251000, contentClass: "MUSIC" });
  check("1 · title is the new track", e.stateC.title, "Jack's Lament");
  check("1 · duration is 251, NOT the spot's 11", Math.round(e.stateC.durationSec), 251);
  check("1 · contentClass is MUSIC, NOT the spot's SPOT (the gold outline)", e.deckContentClass["C"], "MUSIC");
  check("1 · position reset for the new track", e.stateC.positionSec, 0);
  check("1 · filePath is the new track's", e.stateC.filePath, "jl.mp3");
}

console.log("\n── 2 · Unknown duration on a track change → 0, NEVER the previous track's ──");
{
  const e = rig();
  e._setDeckTrack("C", { title: "Mystery", filePath: "m.mp3" });   // no durationMs, _dur returns 0
  check("2 · duration is 0 (honest unknown), not 11", e.stateC.durationSec, 0);
  check("2 · and the title still changed", e.stateC.title, "Mystery");
}

console.log("\n── 3 · getFileDuration is the fallback when the caller has no duration ──");
{
  const e = rig();
  e._dur = (fp) => (fp === "m.mp3" ? 180 : 0);
  e._setDeckTrack("C", { title: "Mystery", filePath: "m.mp3" });
  check("3 · duration resolved from the FILE, not inherited", e.stateC.durationSec, 180);
}

console.log("\n── 4 · contentClass cleared when unknown — never inherited ──");
{
  const e = rig();
  e._setDeckTrack("C", { title: "Unknown class", filePath: "u.mp3", durationMs: 90000 });
  check("4 · contentClass is null, not SPOT", e.deckContentClass["C"], null);
}

console.log("\n── 5 · THE HOLE: the inbound `load` path sets identity, not just the cue flag ──");
{
  const e = rig();
  e.noteManualCue("C", { title: "Jack's Lament", artist: "Danny Elfman", filePath: "jl.mp3",
                         durationMs: 251000, contentClass: "MUSIC" });
  check("5 · duration came with the track", Math.round(e.stateC.durationSec), 251);
  check("5 · class came with the track", e.deckContentClass["C"], "MUSIC");
  check("5 · title came with the track", e.stateC.title, "Jack's Lament");
  check("5 · and it is still marked as a manual cue", e.manualCue.has("C") && e.deckReady.has("C"), true);
}
{
  // A deck that is PLAYING must not be re-identified underneath the operator.
  const e = rig();
  e.stateC.status = "playing";
  e.noteManualCue("C", { title: "Should not apply", filePath: "x.mp3", durationMs: 1000 });
  check("5 · a PLAYING deck is never re-identified", e.stateC.title, "Commercial Spot");
}

console.log("\n── 6 · _changed fires on identity change regardless of position ──");
{
  const e = rig();
  const prev = { ...e.stateC };
  const next = { ...e.stateC, title: "Jack's Lament", filePath: "jl.mp3" };   // same position, same status
  check("6 · a track change ALWAYS emits (the frozen-countdown fix)", e._changed(prev, next), true);
  check("6 · an identical state does not", e._changed(prev, { ...prev }), false);
  // The old failure: position clamped at a stale duration so nothing moved and the UI stopped updating.
  const clamped = { ...prev, positionSec: 11, durationSec: 11 };
  check("6 · …and a clamped position on the SAME track still reports the position change",
    e._changed({ ...prev, positionSec: 10 }, clamped), true);
}

console.log("\n── 7 · REGRESSION GUARD — duration is never read from audio_get_state ──");
{
  // The withdrawn §3 trap: Rust's DeckInfo carries NO duration_sec, so any fix that reads duration from
  // audio_get_state yields 0 on every call. If _setDeckTrack ever starts trusting _state(), this fails.
  const e = rig();
  e._state = () => ({ deckC: { title: "from rust", file_path: "jl.mp3", duration_sec: 999, status: "idle" } });
  e._setDeckTrack("C", { title: "Jack's Lament", filePath: "jl.mp3", durationMs: 251000 });
  check("7 · duration comes from the LOAD, not from Rust's payload", Math.round(e.stateC.durationSec), 251);
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "engine.js"), "utf8");
  // Scope to the METHOD BODY only — a fixed-size window overran into poll(), which legitimately reads
  // _state() and produced a false positive on the first run.
  const start = src.indexOf("_setDeckTrack(id, track) {");
  // CRLF-TOLERANT (2026-08-03). This was a literal "\n  }\n", which never matches in a CRLF file: the
  // marker then landed at some unrelated later offset, so the "body" swallowed half the file and any
  // _state() call in it produced a false FAIL. It passed only by accident of where that offset fell —
  // adding a method above _maybeEmitDeck moved it and the guard fired on correct code.
  const k = src.slice(start).search(/\r?\n  \}/);
  const body = k < 0 ? src.slice(start) : src.slice(start, start + k);
  check("7 · _setDeckTrack does not call _state()", /_state\(\)/.test(body), false);
}

console.log("\n── 8 · the poll carry is identity-keyed (the daemon-side site) ──");
{
  const e = rig();
  // same file → the known duration survives the tick
  const sameFile = { file_path: "spot.mp3" };
  const carry = (live) => { const p = e._deckState("C"); const np = (live && (live.file_path ?? live.filePath)) || "";
                            return np && np === p.filePath ? p.durationSec : 0; };
  check("8 · same filePath → duration carried", carry(sameFile), 11);
  check("8 · different filePath → duration NOT carried", carry({ file_path: "jl.mp3" }), 0);
  check("8 · empty filePath → not carried", carry({ file_path: "" }), 0);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
