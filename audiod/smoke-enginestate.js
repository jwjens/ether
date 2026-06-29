// Regression test for the honest engine-state truth layer (Slice 1).
//
// The ONE invariant this guards: a stalled or silent station can NEVER report a false "LIVE".
// Three sections, all exercising REAL code paths — NO audio device, NO DB, NO pipe, NO second daemon
// process — so it is safe to run at any time, even with live stations on air:
//
//   1) Engine enum     — drives the real DaemonEngine._computeEngineState / _emitEngineState.
//   2) Backend mapping — runs the backend's real deriveStationState (ether-backend/src/station-state.js)
//                        when that sibling repo is present, so the cross-repo contract is covered.
//   3) Push gate       — mirrors App.tsx's now-playing dedupe+keepalive predicate (kept in sync by hand;
//                        it is a tiny, stable expression — see src/App.tsx now-playing heartbeat).
//
// Run:  node audiod/smoke-enginestate.js     (exit 0 = all pass, 1 = a failure)
"use strict";
const path = require("path");

let pass = 0, fail = 0, skip = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

// ── 1) Engine enum (audiod/engine.js) ─────────────────────────────────────────────────────────────
console.log("── 1) daemon engine enum (real DaemonEngine; no audio/DB/pipe) ──");
{
  const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
  const emits = [];
  const e = new DaemonEngine(99, {}, (event, payload) => emits.push({ event, ...payload }));
  const idle = () => { e.stateA = { ...e.stateA, status: "idle" }; e.stateB = { ...e.stateB, status: "idle" }; e.stateC = { ...e.stateC, status: "idle" }; };

  e._started = false; idle();
  check("automation OFF → 'off'", e._computeEngineState(), "off");

  e._started = true; idle(); e.stateA = { ...e.stateA, status: "playing" };
  check("automation ON + deck A playing → 'live'", e._computeEngineState(), "live");

  e._engineState = "off"; e._started = true; idle();
  check("automation ON + nothing playing → 'stalled'", e._computeEngineState(), "stalled");

  e._engineState = "live"; e._started = true; idle(); e._lastPlayingAt = Date.now() - 5000;
  check("ON + silent 5s after live → 'stalled' (never false LIVE)", e._computeEngineState(), "stalled");

  e._engineState = "live"; e._started = true; idle(); e._lastPlayingAt = Date.now() - 200;
  check("ON + 200ms handoff after live → holds 'live' (no flap)", e._computeEngineState(), "live");

  emits.length = 0;
  e._engineState = "off"; e._started = true; idle(); e.stateA = { ...e.stateA, status: "playing" };
  e._emitEngineState();                                   // off → live   (emit)
  e._emitEngineState();                                   // live → live  (no emit)
  idle(); e._lastPlayingAt = Date.now() - 5000;
  e._emitEngineState();                                   // live → stalled (emit)
  check("emits ONLY on transition (live, then stalled)", emits.filter(x => x.event === "enginestate").map(x => x.state), ["live", "stalled"]);
  check("event carries the station id", emits.find(x => x.event === "enginestate")?.stationId, 99);
}

// ── 2) Backend mapping (ether-backend/src/station-state.js) ─────────────────────────────────────────
console.log("\n── 2) backend deriveStationState (real module; the function /api/account/stations calls) ──");
{
  const candidates = [
    process.env.ETHER_BACKEND_DIR && path.join(process.env.ETHER_BACKEND_DIR, "src", "station-state.js"),
    path.join(__dirname, "..", "..", "ether-backend", "src", "station-state.js"),
    "C:\\ether-backend\\src\\station-state.js",
  ].filter(Boolean);
  let mod = null;
  for (const p of candidates) { try { mod = require(p); break; } catch { /* try next */ } }
  if (!mod) {
    console.log("SKIP  ether-backend/src/station-state.js not found (sibling repo absent) — set ETHER_BACKEND_DIR to include this section.");
    skip++;
  } else {
    const { deriveStationState, HEARTBEAT_STALE_MS } = mod;
    const fresh = new Date(Date.now() - 5000).toISOString();
    const stale = new Date(Date.now() - (HEARTBEAT_STALE_MS + 10000)).toISOString();
    check("engine 'stalled' + fresh → 'stalled' (not offline, not live)", deriveStationState("stalled", fresh, false), "stalled");
    check("engine 'off' + fresh → 'off'", deriveStationState("off", fresh, false), "off");
    check("engine 'live' + fresh → 'live'", deriveStationState("live", fresh, true), "live");
    check("engine 'live' but STALE → 'offline'", deriveStationState("live", stale, true), "offline");
    check("engine 'stalled' + STALE → 'offline'", deriveStationState("stalled", stale, false), "offline");
    check("legacy null + fresh + playing → 'live'", deriveStationState(null, fresh, true), "live");
    check("legacy null + fresh + idle → 'off'", deriveStationState(null, fresh, false), "off");
  }
}

// ── 3) Push gate (mirror of src/App.tsx now-playing heartbeat) ──────────────────────────────────────
// skip POST  ⇔  sig === lastSig  AND  (now - lastPostAt) < KEEPALIVE_MS.  Driven at the real 3s tick.
console.log("\n── 3) renderer push gate: real changes POST immediately + silent keepalive (≤20s) ──");
{
  const KEEPALIVE_MS = 20000, TICK_MS = 3000;
  const sigAt = (t) =>
    t >= 245000 ? ["false", "null", "null", "stalled"].join("|") :  // stalled mid-rotation
    t >= 240000 ? ["true", "Song B", "A", "live"].join("|") :       // Song B (real change)
                  ["true", "Song A", "A", "live"].join("|");        // long static track (>90s)
  let lastSig = "", lastPostAt = 0; const posts = [];
  for (let t = 0; t <= 250000; t += TICK_MS) {
    const sig = sigAt(t);
    const skipPost = sig === lastSig && (t - lastPostAt) < KEEPALIVE_MS;
    if (!skipPost) { lastSig = sig; lastPostAt = t; posts.push(t); }
  }
  let maxGap = 0; for (let i = 1; i < posts.length; i++) maxGap = Math.max(maxGap, posts[i] - posts[i - 1]);
  check("Song A start POSTs at t=0", posts.includes(0), true);
  check("Song B change POSTs within one tick of 240s", posts.some(t => t >= 240000 && t < 243000), true);
  check("stall POSTs within one tick of 245s (engine_state in sig)", posts.some(t => t >= 245000 && t < 248000), true);
  check("steady playback in first 20s is deduped (no POST)", posts.filter(t => t > 0 && t < 20000).length, 0);
  check("max POST gap ≤ keepalive + one tick (always fresh < 90s)", maxGap <= KEEPALIVE_MS + TICK_MS, true);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed${skip ? ", " + skip + " skipped" : ""})`);
process.exit(fail === 0 ? 0 : 1);
