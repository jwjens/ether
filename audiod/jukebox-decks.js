"use strict";
// WHICH FADERS THE JUKEBOX MAY PLAY ON — every source fader: D/E/F and S1..S5 (2026-10-04).
//
// Operator requirement, verbatim: "carts announcements jukebox sweepers link they all are just input sources and need
// to work interchangeably on all faders." The jukebox used to be D/E/F only because those were the only source slots
// when it was built; S1..S5 are the same SlotKind::Source in the engine (native/src/audio.rs default_kind_for).
//
// A/B/C stay refused, and that is structural, not a preference: station automation enumerates ["A","B","C"] and a
// public jukebox on a rotation deck would be two schedulers fighting over one deck. CART is the sweeper overlay bus.
//
// Shared by audiod/ether-audiod.js (the daemon's jukebox:* commands) and electron/main.js (the jukebox IPC and its
// in-process fallback), so the two gates cannot drift apart. Pure, so vitest can load it (audiod/interchange.test.js).
const JUKEBOX_DECKS = Object.freeze(["D", "E", "F", "S1", "S2", "S3", "S4", "S5"]);

/** The canonical deck id if `raw` names a jukebox-capable fader (any case), else null. */
function jukeboxDeck(raw) {
  const d = String(raw == null ? "" : raw).toUpperCase();
  return JUKEBOX_DECKS.includes(d) ? d : null;
}

module.exports = { JUKEBOX_DECKS, jukeboxDeck };
