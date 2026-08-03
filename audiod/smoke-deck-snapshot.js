// Bench for D4's deck:snapshot — populate-on-attach (2026-08-03). Real DaemonEngine, no audio/DB/daemon.
//   node audiod/smoke-deck-snapshot.js   (exit 0 = pass)
//
// THE BUG: deck events are emitted only on CHANGE (_maybeEmitDeck). A renderer that attaches late — the
// cold-stage race, where the ~307 MB engine stage outruns the app's connect window — subscribes to a
// stream that then says nothing until the next track change, so its decks stay empty until the app is
// restarted. That is the entire "close and reopen once" ritual.
//
// THE TRAP THIS GUARDS: the snapshot must come from the ENGINE's deck state (duration set by
// _setDeckTrack), NEVER from raw Rust DeckInfo — audio_get_state carries no position_sec/duration_sec,
// so a snapshot built from it paints 0:00 on every deck. That is the 4.4.104 regression, reverted in
// 4.4.106, and case 4 fails the bench if anyone reintroduces it.
"use strict";
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

function rig() {
  const events = [];
  const e = new DaemonEngine(3, {}, (event, payload) => events.push({ event, ...payload }));
  e._log = () => {};
  e._dur = () => 0;                    // no file on disk in a bench
  e._maybeEmitDeck = () => {};         // isolate the snapshot from the poll's change-emitter
  return { e, events };
}
const decksOf = (events) => events.filter(v => v.event === "deck");

console.log("── 1 · a late-attaching renderer gets ALL THREE decks, unconditionally ──");
{
  const { e, events } = rig();
  const r = e.emitDeckSnapshot();
  check("1 · three deck events emitted with no change required", decksOf(events).map(d => d.deck), ["A", "B", "C"]);
  check("1 · every event carries this station's id", decksOf(events).every(d => d.stationId === 3), true);
  check("1 · the command reports ok", r.ok, true);
}

console.log("\n── 2 · the loaded track's identity survives the snapshot ──");
{
  const { e, events } = rig();
  e._setDeckTrack("B", { title: "Jack's Lament", artist: "Danny", filePath: "jack.mp3",
                         durationSec: 251, contentClass: "MUSIC", status: "idle" });
  e.deckReady.add("B");
  e.emitDeckSnapshot();
  const b = decksOf(events).find(d => d.deck === "B");
  check("2 · title", b.state.title, "Jack's Lament");
  check("2 · DURATION is the loaded track's, not 0", b.state.durationSec, 251);
  check("2 · contentClass rides along (gold-outline correctness)", b.state.contentClass, "MUSIC");
  check("2 · ready flag mirrors deckReady", b.ready, true);
  check("2 · filePath", b.state.filePath, "jack.mp3");
}

console.log("\n── 3 · an empty deck reports EMPTY honestly (never invented) ──");
{
  const { e, events } = rig();
  e._setDeckTrack("A", { title: "Loaded", filePath: "a.mp3", durationSec: 120, contentClass: "MUSIC" });
  e.emitDeckSnapshot();
  const c = decksOf(events).find(d => d.deck === "C");
  check("3 · empty deck: no title", c.state.title, "");
  check("3 · empty deck: no filePath", c.state.filePath, "");
  check("3 · empty deck: duration 0, not the neighbour's 120", c.state.durationSec, 0);
  check("3 · empty deck: not ready", c.ready, false);
  check("3 · empty deck: contentClass null, not guessed", c.state.contentClass, null);
}

console.log("\n── 4 · REGRESSION GUARD: the snapshot never reads raw Rust state ──");
{
  const { e, events } = rig();
  let touchedRust = false;
  e._state = () => { touchedRust = true; return { deckA: { status: "playing", duration_sec: 999 } }; };
  e._setDeckTrack("A", { title: "Real", filePath: "a.mp3", durationSec: 187, contentClass: "SPOT" });
  e.emitDeckSnapshot();
  check("4 · _state() (audio_get_state) was NOT called", touchedRust, false);
  check("4 · duration came from the load, not Rust", decksOf(events).find(d => d.deck === "A").state.durationSec, 187);
}
{
  // Source scan, scoped to the method body — the same guard shape smoke-deck-identity uses.
  const src = require("fs").readFileSync(path.join(__dirname, "engine.js"), "utf8");
  const i = src.indexOf("  emitDeckSnapshot() {");
  const body = src.slice(i, i + src.slice(i).search(/\r?\n  \}/));
  check("4 · …and the method body contains no _state() call at all", /this\._state\(/.test(body), false);
}

console.log("\n── 5 · the re-emit cannot make the next poll double-fire ──");
{
  const { e, events } = rig();
  e._setDeckTrack("A", { title: "T", filePath: "a.mp3", durationSec: 100, contentClass: "MUSIC" });
  e.emitDeckSnapshot();
  const before = decksOf(events).length;
  // _maybeEmitDeck is the real one here: with lastFired refreshed by the snapshot, nothing changed.
  delete e._maybeEmitDeck;
  e._maybeEmitDeck("A");
  check("5 · lastFired was refreshed, so no duplicate deck event", decksOf(events).length, before);
}

console.log("\n── 6 · snapshot is idempotent and safe to call on every reattach ──");
{
  const { e, events } = rig();
  e._setDeckTrack("A", { title: "T", filePath: "a.mp3", durationSec: 100 });
  e.emitDeckSnapshot(); e.emitDeckSnapshot();
  check("6 · two calls → six deck events, no throw", decksOf(events).length, 6);
  check("6 · identity identical across both", decksOf(events).filter(d => d.deck === "A").map(d => d.state.durationSec), [100, 100]);
}

console.log("\n── 7 · D3: the adopt carries OBSERVED automation state, so the UI never falls back to KV ──");
{
  const { e, events } = rig();
  e.emitDeckSnapshot();
  const es = events.find(v => v.event === "enginestate");
  check("7 · adopt emits enginestate", !!es, true);
  check("7 · started is FALSE on a fresh engine (never assumed true)", es.started, false);
  check("7 · …and is a real boolean — undefined would leave the UI UNKNOWN forever", typeof es.started, "boolean");
}
{
  const { e, events } = rig();
  e._started = true;                        // automation engaged
  e.emitDeckSnapshot();
  check("7 · an engaged engine reports started TRUE", events.find(v => v.event === "enginestate").started, true);
}

console.log("\n── 8 · the enginestate STREAM carries started too, not only the adopt ──");
{
  const { e, events } = rig();
  e._started = true;
  e._computeEngineState = () => "live";
  e._engineState = "off";
  e._emitEngineState();
  const es = events.find(v => v.event === "enginestate");
  check("8 · change-driven emit carries started", es && es.started, true);
  check("8 · …alongside the state", es && es.state, "live");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
