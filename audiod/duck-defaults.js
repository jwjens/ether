// audiod/duck-defaults.js — THE ONLY PLACE the ducker's STARTING values live (Jeff's ruling, 2026-10-13: "the duck amount
// is set by the user in Preferences, never by code"; docs/duck-from-preferences-2026-10-13.md).
//
// Used once per station, when its Preferences have no ducker values yet: main writes them INTO that station's Preferences
// (board-state.js seedDuckPreferences), where Preferences → Ducker shows and edits them. From then on the engine uses only
// what Preferences says. The engine has no duck amount of its own (native/src/audio.rs BusState::new), the daemon's
// applier has none, and the Ducker panel reads these through main (board:duck-start) — nothing else holds a copy.
// A .js (not .json) because the daemon runs from a staged copy that carries audiod/*.js (audiod/engine-fingerprint.js).
"use strict";
module.exports = Object.freeze({
  depthDb: -22,      // how far the music drops under a source
  thresholdDb: -45,  // source level that starts the duck
  attackMs: 30,      // how fast it drops
  holdMs: 700,       // how long it stays down after the source goes quiet
  releaseMs: 500,    // how fast the music comes back
});
